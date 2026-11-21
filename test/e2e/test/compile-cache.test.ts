import type { TestModule } from 'vitest/node'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { runInlineTests, runVitestCli } from '../../test-utils'

const fixture = resolve(import.meta.dirname, '../fixtures/compile-cache')
const cacheDir = resolve(fixture, 'node_modules/.cache/compile-cache-test')

function cacheEntries(): string[] {
  return readdirSync(cacheDir, { recursive: true, encoding: 'utf-8' }).filter((file) =>
    statSync(join(cacheDir, file)).isFile(),
  )
}

test('NODE_COMPILE_CACHE redirects the compile cache and the worker persists its graph', async () => {
  rmSync(cacheDir, { recursive: true, force: true })

  // the fixture test asserts that the worker sees this exact NODE_COMPILE_CACHE
  const { exitCode } = await runVitestCli(
    {
      nodeOptions: {
        env: {
          NODE_COMPILE_CACHE: cacheDir,
          EXPECTED_COMPILE_CACHE_DIR: cacheDir,
        },
      },
    },
    'run',
    '--root',
    fixture,
  )

  expect(exitCode).toBe(0)

  // jsdom is only loaded inside the worker, so its modules can reach the
  // cache only through the worker flush — the CLI graph alone is ~150 entries,
  // the worker graph pushes it past 1000
  expect(cacheEntries().length).toBeGreaterThan(300)
})

test('NODE_DISABLE_COMPILE_CACHE wins over NODE_COMPILE_CACHE', async () => {
  rmSync(cacheDir, { recursive: true, force: true })

  const { exitCode } = await runVitestCli(
    {
      nodeOptions: {
        env: {
          NODE_COMPILE_CACHE: cacheDir,
          NODE_DISABLE_COMPILE_CACHE: '1',
        },
      },
    },
    'run',
    '--root',
    fixture,
  )

  expect(exitCode).toBe(0)
  expect(existsSync(cacheDir)).toBe(false)
})

test('the cache is stripped from workers when v8 coverage is enabled', async () => {
  rmSync(cacheDir, { recursive: true, force: true })

  const { exitCode } = await runVitestCli(
    {
      nodeOptions: {
        env: {
          NODE_COMPILE_CACHE: cacheDir,
          EXPECT_COVERAGE_STRIPPED: '1',
        },
      },
    },
    'run',
    '--root',
    fixture,
    '--coverage.enabled',
    '--coverage.provider=v8',
    '--coverage.reporter=text',
  )

  expect(exitCode).toBe(0)

  // the CLI process itself still persists its own graph (Node enabled its
  // cache from the env var at startup, before coverage is known), but the
  // worker's jsdom graph must not reach the cache
  const entries = existsSync(cacheDir) ? cacheEntries() : []
  expect(entries.length).toBeLessThan(300)
})

const probe = `
import module from 'node:module'
import { test } from 'vitest'

test('probe', ({ task }) => {
  const cache = module.getCompileCacheDir() ? 'on' : 'off'
  const variables = [process.env.NODE_COMPILE_CACHE, process.env.VITEST_INTERNAL_COMPILE_CACHE].filter(Boolean)
  task.meta.probe = 'cache ' + cache + ', variables ' + variables.length
})
`

function probeFiles(count: number) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`probe-${i}.test.js`, probe]))
}

function probeResults(modules: readonly TestModule[]) {
  const results = modules.flatMap((module) =>
    Array.from(module.children.allTests(), (test) => (test.meta() as { probe?: string }).probe),
  )
  return [...new Set(results)]
}

async function rerunFirstProbe(result: Awaited<ReturnType<typeof runInlineTests>>) {
  const file = result.fs.resolveFile('probe-0.test.js')
  const { testModules } = await result.ctx!.runTestSpecifications(
    result.ctx!.getModuleSpecifications(file),
  )
  return probeResults(testModules.filter((module) => module.moduleId === file))
}

// the shared cache is used only on Linux
const cacheWithTenFiles = process.platform === 'linux' ? 'cache on' : 'cache off'

test.for([
  [10, `${cacheWithTenFiles}, variables 0`],
  [9, 'cache off, variables 0'],
] as const)('%i test files for each worker in watch mode: %s', async ([count, expected]) => {
  const result = await runInlineTests(probeFiles(count), { pool: 'forks', watch: true })

  expect(result.stderr).toBe('')
  expect(probeResults(result.results)).toEqual([expected])
  // a rerun of one file uses the cache only if the previous run created it
  expect(await rerunFirstProbe(result)).toEqual([expected])
})

test.for([
  ['isolate: false', { isolate: false }],
  ['NODE_DISABLE_COMPILE_CACHE', { env: { NODE_DISABLE_COMPILE_CACHE: '1' } }],
] as const)('%s keeps the shared compile cache off', async ([, config]) => {
  const { stderr, results } = await runInlineTests(probeFiles(10), { pool: 'forks', ...config })

  expect(stderr).toBe('')
  expect(probeResults(results)).toEqual(['cache off, variables 0'])
})
