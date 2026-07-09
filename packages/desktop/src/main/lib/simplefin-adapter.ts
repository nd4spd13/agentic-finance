/**
 * Lazy, cached access to `@clad/simplefin-adapter` from the Electron main
 * process — same rationale and pattern as `./clad-core.ts` / `./plaid-
 * adapter.ts`.
 *
 * `@clad/simplefin-adapter`'s `package.json#exports` map declares only an
 * `"import"` condition, same shape as `@clad/core` and `@clad/plaid-
 * adapter`. A *static* import from any `src/main/**` file gets rewritten by
 * electron-vite's CJS main-process bundle to a top-level
 * `require("@clad/simplefin-adapter")` that throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` at module load, before any app code runs —
 * the same S0.2 spike finding (see "Spike results" in
 * packages/docs/plans/desktop-app.md) that motivated `clad-core.ts` and
 * `plaid-adapter.ts`. A dynamic `import()` sidesteps it.
 *
 * The desktop-scoped eslint rule (`packages/desktop/.eslintrc.cjs`) enforces
 * this: `src/main/**` may not statically import `@clad/simplefin-adapter`
 * (or `@clad/core` / `@clad/plaid-adapter`) — go through this module (or the
 * other two) instead.
 */

let cladSimpleFinAdapterPromise: Promise<typeof import('@clad/simplefin-adapter')> | null = null

export function getCladSimpleFinAdapter(): Promise<typeof import('@clad/simplefin-adapter')> {
  if (!cladSimpleFinAdapterPromise) {
    cladSimpleFinAdapterPromise = import('@clad/simplefin-adapter')
  }
  return cladSimpleFinAdapterPromise
}
