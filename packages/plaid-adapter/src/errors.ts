/**
 * Error types for the encrypted token store and the Plaid Link connect flow.
 *
 * By design these carry only non-sensitive, static messages. No token
 * material, passphrase, or derived key is ever interpolated into an error
 * constructed here — see the token store for the redaction discipline that
 * keeps thrown/logged strings clean.
 */

import { redactSecrets } from '@clad/core'

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

/**
 * Thrown when the Plaid Link connect flow (`runLinkFlow` /
 * `runSandboxAutoFlow`) cannot complete — the user exited Link, the flow
 * timed out, the public-token exchange failed, or the callback server errored.
 *
 * The message is defensively passed through `redactSecrets` so that even if a
 * caller ever interpolates a Plaid SDK/axios error (which can embed request
 * headers carrying `PLAID_SECRET`, or `access-`/`public-`/`link-` tokens),
 * no secret material can escape in the thrown/logged string.
 */
export class LinkFlowError extends Error {
  readonly code = 'PLAID_LINK_FLOW_ERROR' as const

  constructor(message: string) {
    super(redactSecrets(message))
    this.name = 'LinkFlowError'
    Object.setPrototypeOf(this, LinkFlowError.prototype)
  }
}
