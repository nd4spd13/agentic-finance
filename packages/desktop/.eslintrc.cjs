/**
 * Desktop-scoped ESLint overrides, layered on top of the repo root
 * `.eslintrc.cjs` (nested config files apply even under a `root: true`
 * ancestor — ESLint merges them per-directory).
 *
 * Enforces the S0.2 spike finding (see "Spike results" in
 * packages/docs/plans/desktop-app.md, and the doc comments on
 * `src/main/lib/clad-core.ts` / `src/main/lib/plaid-adapter.ts` /
 * `src/main/lib/simplefin-adapter.ts`):
 * `@clad/core`, `@clad/plaid-adapter`, and `@clad/simplefin-adapter` are all
 * ESM-only, and electron-vite's default main-process build output is
 * CommonJS, so a *static* import of any of them from `src/main/**` gets
 * rewritten to a top-level `require()` that throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` at module load — crashing the whole main
 * process on startup, before any window is ever shown. Only the dynamic
 * `import()` wrappers in `clad-core.ts` / `plaid-adapter.ts` /
 * `simplefin-adapter.ts` may reference these packages; everything else in
 * `src/main/**` must go through them.
 */
module.exports = {
  overrides: [
    {
      files: ['src/main/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: '@clad/core',
                message:
                  'Static imports of @clad/core crash the CJS main-process bundle at startup ' +
                  '(ERR_PACKAGE_PATH_NOT_EXPORTED — @clad/core is ESM-only). Use getCladCore() ' +
                  'from src/main/lib/clad-core.ts instead.',
              },
              {
                name: '@clad/plaid-adapter',
                message:
                  'Static imports of @clad/plaid-adapter crash the CJS main-process bundle at ' +
                  'startup (ERR_PACKAGE_PATH_NOT_EXPORTED — @clad/plaid-adapter is ESM-only). Use ' +
                  'getCladPlaidAdapter() from src/main/lib/plaid-adapter.ts instead.',
              },
              {
                name: '@clad/simplefin-adapter',
                message:
                  'Static imports of @clad/simplefin-adapter crash the CJS main-process bundle ' +
                  'at startup (ERR_PACKAGE_PATH_NOT_EXPORTED — @clad/simplefin-adapter is ' +
                  'ESM-only). Use getCladSimpleFinAdapter() from ' +
                  'src/main/lib/simplefin-adapter.ts instead.',
              },
            ],
          },
        ],
      },
    },
  ],
}
