export { PlaidAdapter } from './adapter.js'
export type { PlaidAdapterOptions } from './adapter.js'
export type { PlaidClientLike } from './plaid-client.types.js'
export type { TokenStore, StoredItemMeta, StoredItemInput } from './token-store.types.js'

// WP3 — encrypted token store
export { deriveKey, encrypt, decrypt } from './crypto.js'
export type { EncryptedPayload } from './crypto.js'
export { SqliteTokenStore } from './token-store.js'
export type { SqliteTokenStoreOptions } from './token-store.js'
export { TokenStoreKeyError } from './errors.js'
