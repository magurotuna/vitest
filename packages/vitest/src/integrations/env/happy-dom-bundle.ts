import type { SerializedConfig } from '../../runtime/config'
import module from 'node:module'
import { pathToFileURL } from 'node:url'

type PreBundledHappyDom = NonNullable<SerializedConfig['experimental']['preBundledHappyDom']>

export function isInnerHappyDomImport(id: string): boolean {
  return id.startsWith('happy-dom/') && id !== 'happy-dom/package.json'
}

export function createInnerHappyDomImportError(id: string): Error {
  return new Error(
    `Cannot import "${id}" when \`experimental.preBundleEnvironment\` is enabled. ` +
      'The environment uses a bundled copy of happy-dom, so this file would be a second copy. ' +
      'Import from "happy-dom" instead, or disable the option.',
  )
}

interface Redirect {
  bundleUrl: string
  // the URLs below are lowercase on Windows, where paths can differ in letter case
  bundle: string
  entry: string
  packageDir: string | undefined
  packageJson: string | undefined
}

const isWindows = process.platform === 'win32'
const normalizeUrl = (url: string) => (isWindows ? url.toLowerCase() : url)
let redirect: Redirect | undefined
let hooksRegistered = false

export function redirectHappyDomImports(preBundled: PreBundledHappyDom | undefined): void {
  redirect = preBundled && createRedirect(preBundled)
  if (!redirect || hooksRegistered) {
    return
  }
  hooksRegistered = true
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!redirect) {
        return nextResolve(specifier, context)
      }
      if (specifier === 'happy-dom') {
        return { url: redirect.bundleUrl, format: 'module', shortCircuit: true }
      }
      if (isInnerHappyDomImport(specifier)) {
        throw createInnerHappyDomImportError(specifier)
      }
      const result = nextResolve(specifier, context)
      const url = normalizeUrl(result.url)
      if (url === redirect.bundle) {
        return url === result.url ? result : { ...result, url: redirect.bundleUrl }
      }
      // a file path or an alias can lead to the files of the package
      if (url === redirect.entry) {
        return { url: redirect.bundleUrl, format: 'module', shortCircuit: true }
      }
      if (
        redirect.packageDir &&
        url.startsWith(redirect.packageDir) &&
        url !== redirect.packageJson
      ) {
        throw createInnerHappyDomImportError(specifier)
      }
      return result
    },
  })
}

function createRedirect({ file, entry, packageDir }: PreBundledHappyDom): Redirect {
  const bundleUrl = pathToFileURL(file).href
  const packageDirUrl = packageDir && `${pathToFileURL(packageDir).href}/`
  return {
    bundleUrl,
    bundle: normalizeUrl(bundleUrl),
    entry: normalizeUrl(pathToFileURL(entry).href),
    packageDir: packageDirUrl && normalizeUrl(packageDirUrl),
    packageJson: packageDirUrl && normalizeUrl(`${packageDirUrl}package.json`),
  }
}
