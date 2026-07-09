export { PlaidAdapter } from './adapter.js'
export type { PlaidAdapterOptions } from './adapter.js'
export type { PlaidClientLike } from './plaid-client.types.js'
export { createPlaidClient } from './plaid-client.js'
export type { CreatePlaidClientOptions } from './plaid-client.js'
// Token storage (SqliteTokenStore and friends) moved to `@clad/core` in SF5 —
// it was already provider-agnostic, and `@clad/simplefin-adapter` needed the
// same encrypted-at-rest storage. Re-exported here so existing imports of
// these names from `@clad/plaid-adapter` (e.g. `clad connect`,
// `provider-factory.ts`) keep working unchanged.
export type { TokenStore, StoredItemMeta, StoredItemInput } from '@clad/core'
export { deriveKey, encrypt, decrypt } from '@clad/core'
export type { EncryptedPayload } from '@clad/core'
export { SqliteTokenStore } from '@clad/core'
export type { SqliteTokenStoreOptions } from '@clad/core'
export { TokenStoreKeyError } from '@clad/core'
export { LinkFlowError } from './errors.js'
export {
  createLinkToken,
  runLinkFlow,
  runSandboxAutoFlow,
} from './link.js'
export type {
  CreateLinkTokenOptions,
  RunLinkFlowOptions,
  RunSandboxAutoFlowOptions,
  LinkFlowResult,
  LinkedAccount,
} from './link.js'
export { PlaidCache } from './cache.js'
export type { CachedAccount, CachedTransaction } from './cache.js'
export { mapAccount, mapAccountType, mapRecurringCharge, mapTransaction } from './mapping.js'
