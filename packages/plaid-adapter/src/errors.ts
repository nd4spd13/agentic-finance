/**
 * Error type for the Plaid Link connect flow.
 *
 * By design this carries only redacted messages — no token material,
 * passphrase, or derived key is ever interpolated into an error constructed
 * here. `TokenStoreKeyError` used to live in this file too; it moved to
 * `@clad/core` in SF5 alongside `SqliteTokenStore` (it was never
 * Plaid-specific — see `packages/core/src/security/token-store-errors.ts`).
 * It's still available as `import { TokenStoreKeyError } from
 * '@clad/plaid-adapter'` via the re-export in `index.ts`.
 */

import { redactSecrets } from '@clad/core'

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
