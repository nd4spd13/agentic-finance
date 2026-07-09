/**
 * Lazy, cached access to `@clad/core` from the Electron main process.
 *
 * Empirical S0.2 finding: `@clad/core`'s `package.json#exports` map declares
 * only an `"import"` condition (no `"require"`, no `"default"`) — same shape
 * as `@clad/plaid-adapter`. electron-vite's default main-process build
 * output is CommonJS, so a *static* `import { redactSecrets } from
 * '@clad/core'` gets rewritten by the bundler to a top-level
 * `require("@clad/core")` that runs eagerly at module load and throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` immediately — before any spike code even
 * runs, taking down the whole main process on startup. This bit us during
 * the S0 spike (see "Spike results" in desktop-app.md) and applies to
 * `@clad/core` just as much as it does to `@clad/plaid-adapter`; the
 * existing dynamic-import seam in `packages/mcp-server/src/provider-
 * factory.ts` only special-cases the latter because `mcp-server`'s own
 * build output is ESM, so its *own* static `@clad/core` import is fine
 * there — a distinction that does not carry over to a CJS-output consumer
 * like this app.
 *
 * Fix: dynamic `import()` only, cached after first resolution so callers
 * don't re-pay the import cost per call.
 */

let cladCorePromise: Promise<typeof import('@clad/core')> | null = null

export function getCladCore(): Promise<typeof import('@clad/core')> {
  if (!cladCorePromise) {
    cladCorePromise = import('@clad/core')
  }
  return cladCorePromise
}
