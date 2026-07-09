/**
 * Lazy, cached access to `@clad/plaid-adapter` from the Electron main
 * process — same rationale and pattern as `./clad-core.ts`.
 *
 * `@clad/plaid-adapter`'s `package.json#exports` map declares only an
 * `"import"` condition, same as `@clad/core`. A *static* import from any
 * `src/main/**` file gets rewritten by electron-vite's CJS main-process
 * bundle to a top-level `require("@clad/plaid-adapter")` that throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` at module load, before any app code runs —
 * this is the S0.2 spike finding (see "Spike results" in
 * packages/docs/plans/desktop-app.md). A dynamic `import()` sidesteps it.
 *
 * The desktop-scoped eslint rule (`packages/desktop/.eslintrc.cjs`) enforces
 * this: `src/main/**` may not statically import `@clad/plaid-adapter`
 * (or `@clad/core`) — go through this module (or `./clad-core.ts`) instead.
 */

let cladPlaidAdapterPromise: Promise<typeof import('@clad/plaid-adapter')> | null = null

export function getCladPlaidAdapter(): Promise<typeof import('@clad/plaid-adapter')> {
  if (!cladPlaidAdapterPromise) {
    cladPlaidAdapterPromise = import('@clad/plaid-adapter')
  }
  return cladPlaidAdapterPromise
}
