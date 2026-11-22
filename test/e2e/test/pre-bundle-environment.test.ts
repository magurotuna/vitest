import type { TestFsStructure } from '#test-utils'
import module from 'node:module'
import { describe, expect, test } from 'vitest'
import { runInlineTests, runVitest } from '#test-utils'

const dependencies: TestFsStructure = {
  'node_modules/esm-dep/package.json': JSON.stringify({
    name: 'esm-dep',
    type: 'module',
    exports: './index.js',
  }),
  'node_modules/esm-dep/index.js': `export { HTMLElement } from 'happy-dom'`,
  'node_modules/cjs-dep/package.json': JSON.stringify({ name: 'cjs-dep', main: './index.js' }),
  'node_modules/cjs-dep/index.js': `
exports.HTMLElement = require('happy-dom').HTMLElement
exports.name = require('happy-dom/package.json').name
`,
  'node_modules/path-dep/package.json': JSON.stringify({
    name: 'path-dep',
    type: 'module',
    exports: './index.js',
  }),
  'node_modules/path-dep/index.js': `
const entry = new URL('./lib/index.js', import.meta.resolve('happy-dom/package.json'))
export const { HTMLElement } = await import(entry.href)
`,
  'node_modules/inner-dep/package.json': JSON.stringify({
    name: 'inner-dep',
    type: 'module',
    exports: './index.js',
  }),
  'node_modules/inner-dep/index.js': `export * from 'happy-dom/lib/PropertySymbol.js'`,
  'node_modules/inner-cjs-dep/package.json': JSON.stringify({
    name: 'inner-cjs-dep',
    main: './index.js',
  }),
  'node_modules/inner-cjs-dep/index.js': `module.exports = require('happy-dom/lib/PropertySymbol.js')`,
}

// returns where the code that dispatches events comes from
const probe = `
function loadedHappyDom() {
  const { prepareStackTrace, stackTraceLimit } = Error
  let files = []
  Error.stackTraceLimit = 50
  Error.prepareStackTrace = (_, callSites) =>
    callSites.map(callSite => (callSite.getFileName() ?? '').replaceAll('\\\\', '/'))
  try {
    const element = document.createElement('div')
    element.addEventListener('probe', () => {
      files = new Error().stack
    })
    element.dispatchEvent(new window.Event('probe'))
  } finally {
    Error.prepareStackTrace = prepareStackTrace
    Error.stackTraceLimit = stackTraceLimit
  }
  if (files.some(file => file.includes('/deps___vitest_happy_dom__/'))) {
    return 'bundle'
  }
  if (files.some(file => file.includes('/node_modules/happy-dom/'))) {
    return 'package'
  }
  return files.join('\\n')
}
`

// `server.deps.inline: true` evaluates the files of happy-dom in the module runner, which fails without this option too
const createIdentityTest = ({ pathDep = true } = {}) => `
import * as happyDom from 'happy-dom'
import * as esmDep from 'esm-dep'
import * as cjsDep from 'cjs-dep'
${pathDep ? `import * as pathDep from 'path-dep'` : 'const pathDep = happyDom'}
import { expect, test, vi } from 'vitest'
${probe}

test('the environment loads the expected happy-dom', () => {
  expect(loadedHappyDom()).toBe(process.env.EXPECTED_HAPPY_DOM)
})

test('the test file, the dependencies, and the environment share one happy-dom', () => {
  const element = document.createElement('div')
  expect(element).toBeInstanceOf(happyDom.HTMLElement)
  expect(element).toBeInstanceOf(esmDep.HTMLElement)
  expect(element).toBeInstanceOf(cjsDep.HTMLElement)
  expect(element).toBeInstanceOf(pathDep.HTMLElement)
  expect(cjsDep.name).toBe('happy-dom')
})

test('classes keep their names', () => {
  expect(Object.prototype.toString.call(document)).toBe('[object HTMLDocument]')
  expect(document.constructor.name).toBe('HTMLDocument')

  const target = new window.EventTarget()
  target.onprobe = vi.fn()
  target.dispatchEvent(new window.Event('probe'))
  expect(target.onprobe).not.toHaveBeenCalled()

  document.body.innerHTML = '<p>text</p>'
  expect(document.body.firstChild).toMatchInlineSnapshot(\`
    <p>
      text
    </p>
  \`)
})
`
const identityTest = createIdentityTest()

const identityTree = {
  'the environment loads the expected happy-dom': 'passed',
  'the test file, the dependencies, and the environment share one happy-dom': 'passed',
  'classes keep their names': 'passed',
}

interface Row {
  name: string
  pool?: string
  viteModuleRunner?: boolean
  isolate?: boolean
  inline?: boolean
  enabled?: boolean
  expected: string
}

describe.runIf(module.registerHooks)('supported', () => {
  test.for<Row>([
    { name: 'forks', pool: 'forks', expected: 'bundle' },
    { name: 'threads', pool: 'threads', expected: 'bundle' },
    { name: 'forks without the module runner', viteModuleRunner: false, expected: 'bundle' },
    {
      name: 'threads without the module runner',
      pool: 'threads',
      viteModuleRunner: false,
      expected: 'bundle',
    },
    { name: 'forks without isolation', isolate: false, expected: 'bundle' },
    { name: 'inlined dependencies', inline: true, expected: 'bundle' },
    { name: 'disabled', enabled: false, expected: 'package' },
    {
      name: 'disabled without the module runner',
      enabled: false,
      viteModuleRunner: false,
      expected: 'package',
    },
  ])('$name', async ({ pool, viteModuleRunner, isolate, inline, enabled, expected }) => {
    const { stderr, testTree } = await runInlineTests({
      ...dependencies,
      'first.test.js': createIdentityTest({ pathDep: !inline }),
      'second.test.js': createIdentityTest({ pathDep: !inline }),
      'vitest.config.js': {
        test: {
          pool,
          isolate,
          environment: 'happy-dom',
          env: { EXPECTED_HAPPY_DOM: expected },
          server: inline ? { deps: { inline: true } } : undefined,
          experimental: { viteModuleRunner, preBundleEnvironment: enabled ?? true },
        },
      },
    })

    expect(stderr).toBe('')
    expect(testTree()).toEqual({ 'first.test.js': identityTree, 'second.test.js': identityTree })
  })

  test('a file with the happy-dom environment comment uses the bundle', async () => {
    const { stderr, testTree } = await runInlineTests({
      ...dependencies,
      'basic.test.js': `// @vitest-environment happy-dom\n${identityTest}`,
      'vitest.config.js': {
        test: {
          environment: 'node',
          env: { EXPECTED_HAPPY_DOM: 'bundle' },
          experimental: { preBundleEnvironment: true },
        },
      },
    })

    expect(stderr).toBe('')
    expect(testTree()).toEqual({ 'basic.test.js': identityTree })
  })

  test.for([
    { root: undefined, project: true, expected: 'bundle' },
    { root: true, project: undefined, expected: 'bundle' },
    { root: true, project: false, expected: 'package' },
  ])(
    'an inline project with $project in a config with $root',
    async ({ root, project, expected }) => {
      const { stderr, testTree } = await runInlineTests({
        ...dependencies,
        'project/basic.test.js': identityTest,
        'vitest.config.js': {
          test: {
            experimental: { preBundleEnvironment: root },
            projects: [
              {
                test: {
                  name: 'project',
                  include: ['project/*.test.js'],
                  environment: 'happy-dom',
                  env: { EXPECTED_HAPPY_DOM: expected },
                  experimental: { preBundleEnvironment: project },
                },
              },
            ],
          },
        },
      })

      expect(stderr).toBe('')
      expect(testTree()).toEqual({ 'project/basic.test.js': identityTree })
    },
  )

  test('a project config file enables the option', async () => {
    const { stderr, testTree } = await runInlineTests({
      ...dependencies,
      'project/basic.test.js': identityTest,
      'project/vitest.config.js': {
        test: {
          environment: 'happy-dom',
          env: { EXPECTED_HAPPY_DOM: 'bundle' },
          experimental: { preBundleEnvironment: true },
        },
      },
      'vitest.config.js': { test: { projects: ['project'] } },
    })

    expect(stderr).toBe('')
    expect(testTree()).toEqual({ 'basic.test.js': identityTree })
  })

  test('a cached test file does not keep the bundle after the option is disabled', async () => {
    const config = (enabled: boolean) => ({
      environment: 'happy-dom',
      env: { EXPECTED_HAPPY_DOM: enabled ? 'bundle' : 'package' },
      fsModuleCache: true,
      fsModuleCachePath: './node_modules/.test-module-cache',
      experimental: { preBundleEnvironment: enabled },
    })
    const first = await runInlineTests(
      { ...dependencies, 'basic.test.js': identityTest },
      config(true),
    )
    expect(first.stderr).toBe('')
    expect(first.testTree()).toEqual({ 'basic.test.js': identityTree })

    const second = await runVitest({ root: first.fs.root, ...config(false) })
    expect(second.stderr).toBe('')
    expect(second.testTree()).toEqual({ 'basic.test.js': identityTree })
  })

  test.for([true, false])(
    'vi.mock replaces happy-dom with viteModuleRunner: %s',
    async (viteModuleRunner) => {
      const { stderr, testTree } = await runInlineTests({
        'basic.test.js': `
import { expect, test, vi } from 'vitest'
import { Window } from 'happy-dom'

vi.mock('happy-dom', () => ({ Window: 'mocked' }))

test('mocked', () => {
  expect(Window).toBe('mocked')
  expect(document.constructor.name).toBe('HTMLDocument')
})
`,
        'vitest.config.js': {
          test: {
            environment: 'happy-dom',
            experimental: { viteModuleRunner, preBundleEnvironment: true },
          },
        },
      })

      expect(stderr).toBe('')
      expect(testTree()).toEqual({ 'basic.test.js': { mocked: 'passed' } })
    },
  )

  test('vmForks loads happy-dom from the bundle', async () => {
    const { stderr, testTree } = await runInlineTests({
      'basic.test.js': `
import { expect, test } from 'vitest'
${probe}

test('the environment loads the bundle', () => {
  expect(loadedHappyDom()).toBe('bundle')
})
`,
      'vitest.config.js': {
        test: {
          pool: 'vmForks',
          environment: 'happy-dom',
          experimental: { preBundleEnvironment: true },
        },
      },
    })

    expect(stderr).toBe('')
    expect(testTree()).toMatchInlineSnapshot(`
      {
        "basic.test.js": {
          "the environment loads the bundle": "passed",
        },
      }
    `)
  })

  test('an import of an inner happy-dom file fails', async () => {
    const unreachable = `
import { test } from 'vitest'

test('unreachable', () => {})
`
    const { errorTree } = await runInlineTests({
      ...dependencies,
      'test-file.test.js': `import 'happy-dom/lib/PropertySymbol.js'\n${unreachable}`,
      'esm-dependency.test.js': `import 'inner-dep'\n${unreachable}`,
      'cjs-dependency.test.js': `import 'inner-cjs-dep'\n${unreachable}`,
      'vitest.config.js': {
        test: {
          environment: 'happy-dom',
          experimental: { preBundleEnvironment: true },
        },
      },
    })

    expect(errorTree()).toMatchInlineSnapshot(`
      {
        "cjs-dependency.test.js": {
          "__module_errors__": [
            "Cannot import "happy-dom/lib/PropertySymbol.js" when \`experimental.preBundleEnvironment\` is enabled. The environment uses a bundled copy of happy-dom, so this file would be a second copy. Import from "happy-dom" instead, or disable the option.",
          ],
        },
        "esm-dependency.test.js": {
          "__module_errors__": [
            "Cannot import "happy-dom/lib/PropertySymbol.js" when \`experimental.preBundleEnvironment\` is enabled. The environment uses a bundled copy of happy-dom, so this file would be a second copy. Import from "happy-dom" instead, or disable the option.",
          ],
        },
        "test-file.test.js": {
          "__module_errors__": [
            "Cannot import "happy-dom/lib/PropertySymbol.js" when \`experimental.preBundleEnvironment\` is enabled. The environment uses a bundled copy of happy-dom, so this file would be a second copy. Import from "happy-dom" instead, or disable the option.",
          ],
        },
      }
    `)
  })
})

describe.runIf(!module.registerHooks)('unsupported', () => {
  test('prints a warning and loads happy-dom without the bundle', async () => {
    const { stderr, testTree } = await runInlineTests({
      ...dependencies,
      'basic.test.js': identityTest,
      'vitest.config.js': {
        test: {
          environment: 'happy-dom',
          env: { EXPECTED_HAPPY_DOM: 'package' },
          experimental: { preBundleEnvironment: true },
        },
      },
    })

    expect(stderr).toContain(
      `\`experimental.preBundleEnvironment\` needs "module.registerHooks", which Node.js 22.15 and later support. Vitest loads happy-dom without the bundle in Node.js ${process.version}.`,
    )
    expect(testTree()).toEqual({ 'basic.test.js': identityTree })
  })
})
