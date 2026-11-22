import type { EnvironmentOptions, Plugin, ViteDevServer } from 'vite'
import type { SerializedConfig } from '../../runtime/config'
import { realpathSync } from 'node:fs'
import module, { builtinModules } from 'node:module'
import { isPackageExists } from 'local-pkg'
import { normalize, resolve } from 'pathe'
import * as vite from 'vite'
import {
  createInnerHappyDomImportError,
  isInnerHappyDomImport,
} from '../../integrations/env/happy-dom-bundle'

type PreBundledHappyDom = NonNullable<SerializedConfig['experimental']['preBundledHappyDom']>

export const preBundleEnvironmentName = '__vitest_happy_dom__'

const preBundledHappyDom = new WeakMap<ViteDevServer, PreBundledHappyDom>()

export function getPreBundledHappyDom(server: ViteDevServer): PreBundledHappyDom | undefined {
  const cached = preBundledHappyDom.get(server)
  if (cached) {
    return cached
  }
  const dep =
    server.environments[preBundleEnvironmentName]?.depsOptimizer?.metadata.optimized['happy-dom']
  // the bundle of a CommonJS entry has no named exports
  if (!dep?.src || dep.needsInterop) {
    return
  }
  const entry = realpath(dep.src)
  const packageDirIndex = entry.lastIndexOf('/node_modules/happy-dom/')
  const result: PreBundledHappyDom = {
    // Node.js loads a file once for its real path
    file: realpath(dep.file),
    entry,
    packageDir:
      packageDirIndex === -1
        ? undefined
        : entry.slice(0, packageDirIndex + '/node_modules/happy-dom'.length),
  }
  preBundledHappyDom.set(server, result)
  return result
}

function realpath(file: string): string {
  try {
    return normalize(realpathSync(file))
  } catch {
    return file
  }
}

let warnedMissingRegisterHooks = false

export function PreBundleEnvironmentPlugin(): Plugin {
  let server: ViteDevServer | undefined
  let missingRegisterHooks = false
  return {
    name: 'vitest:pre-bundle-environment',
    enforce: 'pre',
    config: {
      order: 'post',
      handler(config) {
        const test = config.test
        if (!test?.experimental?.preBundleEnvironment || test.browser?.enabled) {
          return
        }
        const root = resolve(test.root || config.root || process.cwd())
        if (!isPackageExists('happy-dom', { paths: [root] })) {
          return
        }
        // the workers redirect `happy-dom` imports of dependencies with this API
        if (typeof module.registerHooks !== 'function') {
          missingRegisterHooks = true
          return
        }
        config.environments ??= {}
        config.environments[preBundleEnvironmentName] = {
          consumer: 'server',
          optimizeDeps: {
            noDiscovery: true,
            include: ['happy-dom'],
            ...getOptimizerOptions(),
          },
        }
      },
    },
    configResolved(config) {
      if (missingRegisterHooks && !warnedMissingRegisterHooks) {
        warnedMissingRegisterHooks = true
        config.logger.warn(
          `\`experimental.preBundleEnvironment\` needs "module.registerHooks", which Node.js 22.15 and later support. Vitest loads happy-dom without the bundle in Node.js ${process.version}.`,
        )
      }
    },
    configureServer(viteServer) {
      server = viteServer
    },
    configureVitest({ project, defineCacheKeyGenerator }) {
      const file = getPreBundledHappyDom(project.vite)?.file
      if (file) {
        // cached test files keep the resolved `happy-dom` import
        defineCacheKeyGenerator(() => `happy-dom-bundle:${file}`)
      }
    },
    resolveId(id) {
      if (id !== 'happy-dom' && !id.startsWith('happy-dom/')) {
        return
      }
      if (!server || this.environment.name === preBundleEnvironmentName) {
        return
      }
      const preBundled = getPreBundledHappyDom(server)
      if (!preBundled) {
        return
      }
      if (id === 'happy-dom') {
        return preBundled.file
      }
      if (isInnerHappyDomImport(id)) {
        this.error(createInnerHappyDomImportError(id).message)
      }
    },
  }
}

// Node.js loads the built-in module for `url` even if a `url` package is installed
const builtinModuleRE = new RegExp(`^(?:node:.*|${builtinModules.join('|')})$`)

function getOptimizerOptions(): EnvironmentOptions['optimizeDeps'] {
  if ('rolldownVersion' in vite) {
    return {
      rolldownOptions: {
        // `ssr.target: 'webworker'` would select the browser platform
        platform: 'node',
        external: [builtinModuleRE],
        output: {
          // happy-dom reads `constructor.name`, and the bundler renames classes with the same name
          keepNames: true,
          // V8 reads top-level `var` bindings slower than `const` ones in happy-dom's hot paths
          topLevelVar: false,
        },
      },
    }
  }
  return {
    esbuildOptions: {
      platform: 'node',
      keepNames: true,
      plugins: [
        {
          name: 'vitest:external-builtin-modules',
          setup(build) {
            build.onResolve({ filter: builtinModuleRE }, ({ path }) => ({ path, external: true }))
          },
        },
      ],
    },
  }
}
