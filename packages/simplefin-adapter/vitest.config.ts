import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * `node:sqlite` is exposed only under the `node:` prefix and is NOT listed in
 * `module.builtinModules`, so Vite/Vitest does not recognize it as a Node
 * builtin. It strips the `node:` prefix and tries (and fails) to load a
 * package named `sqlite`. We alias `node:sqlite` to a tiny shim that loads the
 * real builtin via `createRequire` at runtime — see
 * `test/setup/node-sqlite-shim.ts` (mirrors `plaid-adapter`'s vitest config).
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
