/**
 * Error type for `SqliteTokenStore` (see `token-store.ts`).
 *
 * By design this carries only a fixed, non-sensitive message. No token
 * material, passphrase, or derived key is ever interpolated into it.
 *
 * Split out of `@clad/plaid-adapter`'s `errors.ts` in SF5 alongside the
 * token store itself: `TokenStoreKeyError` was never Plaid-specific (it's
 * thrown by the storage layer, not by anything talking to the Plaid API),
 * so it moved with `token-store.ts` to `@clad/core`. `@clad/plaid-adapter`'s
 * own `LinkFlowError` (genuinely Plaid Link-specific) stayed behind in that
 * package's `errors.ts`. `@clad/plaid-adapter` re-exports this class from
 * its own `index.ts` so existing imports of `TokenStoreKeyError` from
 * `@clad/plaid-adapter` keep working unchanged.
 */

/**
 * Thrown when the token store cannot verify the passphrase against the stored
 * key-check record on open — i.e. the derived key does not match the one that
 * originally sealed the database (wrong passphrase, or a corrupted/mismatched
 * `meta` row).
 *
 * The message is a fixed constant so it can never leak the passphrase, the
 * derived key, or any token bytes.
 */
export class TokenStoreKeyError extends Error {
  readonly code = 'TOKEN_STORE_KEY_MISMATCH' as const

  constructor() {
    super(
      'Failed to unlock the token store: the passphrase does not match the one ' +
        'used to initialize this database. No secret material is included in this error.'
    )
    this.name = 'TokenStoreKeyError'
  }
}
