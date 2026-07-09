/**
 * Test-only shim for `node:sqlite`. See `vitest.config.ts` for why this is
 * needed — identical to the shim in `@clad/cli` and `@clad/plaid-adapter`.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sqlite = require('node:sqlite') as typeof import('node:sqlite')

export const DatabaseSync = sqlite.DatabaseSync
