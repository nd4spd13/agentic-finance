export { PlaidAdapter } from './adapter.js'
export type { PlaidAdapterOptions } from './adapter.js'
export type { PlaidClientLike } from './plaid-client.types.js'
export type { TokenStore, StoredItemMeta, StoredItemInput } from './token-store.types.js'

// WP5 additions (appended, not interleaved, to merge cleanly with WP3/WP4).
export { PlaidCache } from './cache.js'
export type { CachedAccount, CachedTransaction } from './cache.js'
export { mapAccount, mapAccountType, mapRecurringCharge, mapTransaction } from './mapping.js'
