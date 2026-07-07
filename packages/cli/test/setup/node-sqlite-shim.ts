/**
 * Test-only shim for `node:sqlite`.
 *
 * Vite (and thus Vitest) does not recognize `node:sqlite` as a Node builtin —
 * it is exposed only under the `node:` prefix and is absent from
 * `module.builtinModules` — so it tries to bundle a nonexistent `sqlite`
 * package and fails. The vitest config aliases `node:sqlite` to this file,
 * which loads the real builtin through `createRequire` at runtime (CommonJS
 * `require` resolves `node:` builtins correctly regardless of the bundler).
 *
 * The CLI's approval/audit commands reach `node:sqlite` transitively through
 * `@clad/core`; this mirrors the identical shim in `@clad/plaid-adapter`.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sqlite = require('node:sqlite') as typeof import('node:sqlite')

export const DatabaseSync = sqlite.DatabaseSync
