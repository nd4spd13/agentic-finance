/**
 * Error types for the encrypted token store.
 *
 * By design these carry only non-sensitive, static messages. No token
 * material, passphrase, or derived key is ever interpolated into an error
 * constructed here — see the token store for the redaction discipline that
 * keeps thrown/logged strings clean.
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
