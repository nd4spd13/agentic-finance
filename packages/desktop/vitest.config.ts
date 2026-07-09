import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * `node:sqlite` is exposed only under the `node:` prefix and is NOT listed
 * in `module.builtinModules`, so Vite/Vitest does not recognize it as a Node
 * builtin — it strips the `node:` prefix and tries (and fails) to load a
 * package named `sqlite`. Alias it to a shim that loads the real builtin via
 * `createRequire` at runtime — same fix as `@clad/plaid-adapter` and
 * `@clad/cli`'s vitest configs. Reached here transitively: `passphrase.ts`'s
 * `verifyCliPassphrase` dynamic-imports `@clad/plaid-adapter`, whose
 * `SqliteTokenStore` uses `node:sqlite`.
 *
 * Only the pure/DI'd modules under `src/main/lib/**` are unit-tested here
 * (no `electron` import in any of them — see each module's doc comment);
 * nothing in this package's test suite boots a real Electron process.
 */
const nodeSqliteShim = fileURLToPath(new URL('./test/setup/node-sqlite-shim.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'node:sqlite': nodeSqliteShim,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
