import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The CLI's approval/audit commands reach the `node:sqlite` builtin
 * transitively through `@clad/core`. Vite doesn't recognize `node:sqlite` as a
 * Node builtin (it's absent from `module.builtinModules`), so it strips the
 * `node:` prefix and fails to load a nonexistent `sqlite` package. Alias
 * `node:sqlite` to a shim that loads the real builtin via `createRequire` —
 * same fix as `@clad/plaid-adapter`.
 */
const nodeSqliteShim = fileURLToPath(new URL('./test/setup/node-sqlite-shim.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'node:sqlite': nodeSqliteShim,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
