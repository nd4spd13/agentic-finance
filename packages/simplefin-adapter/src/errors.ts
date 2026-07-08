/**
 * Error hierarchy for the SimpleFIN Bridge adapter.
 *
 * `SimpleFinError` is the common base every SimpleFIN-specific error extends.
 * It carries a `code` string so callers can branch on failure category
 * without parsing message text, and defensively passes every message through
 * `redactSecrets` from `@clad/core` before it becomes `Error#message` — the
 * same discipline `plaid-adapter/src/errors.ts` uses for `LinkFlowError`.
 *
 * SF2 only needs the token-decode and claim-POST failure modes, so only
 * {@link SimpleFinTokenError} and {@link SimpleFinClaimError} are defined
 * here. SF3 will extend this hierarchy with subclasses (and richer `code`
 * values) mapped from the protocol's `gen.`/`con.`/`act.` error-code
 * prefixes and the `402`/`403` HTTP semantics described in the plan's
 * "Protocol reference" section — this file is the seam for that work, not
 * the finished mapping.
 *
 * Security invariant: no constructor here ever interpolates the SimpleFIN
 * access URL (or any string that might carry it, such as a raw claim
 * response body) into a message. `claim.ts` is responsible for only ever
 * passing static, non-credential-bearing text into these constructors.
 */

import { redactSecrets } from '@clad/core'

export interface SimpleFinErrorOptions {
  /**
   * Machine-readable failure category. SF2 uses local, non-protocol codes
   * (`local.*`) since no request ever reaches the point of returning a
   * `gen.`/`con.`/`act.` subcode; SF3 will populate this from parsed
   * `AccountSet` error entries and HTTP status instead.
   */
  code?: string
}

/**
 * Base class for every error this package throws. Never construct this
 * directly outside the package — throw one of its subclasses instead so
 * callers can `instanceof`-narrow on failure category.
 */
export class SimpleFinError extends Error {
  readonly code: string

  constructor(message: string, options: SimpleFinErrorOptions = {}) {
    super(redactSecrets(message))
    this.name = 'SimpleFinError'
    this.code = options.code ?? 'local.simplefin_error'
    Object.setPrototypeOf(this, SimpleFinError.prototype)
  }
}

/**
 * Thrown when a setup token cannot be decoded into a usable claim URL:
 * empty input, invalid base64, or base64 that decodes to something other
 * than a well-formed `http(s)` URL.
 */
export class SimpleFinTokenError extends SimpleFinError {
  constructor(message: string) {
    super(message, { code: 'local.invalid_setup_token' })
    this.name = 'SimpleFinTokenError'
    Object.setPrototypeOf(this, SimpleFinTokenError.prototype)
  }
}

/**
 * Thrown when the one-time claim POST fails: a network error reaching the
 * claim URL, a non-2xx response (including reuse of an already-claimed
 * token), or a 2xx response whose body is not a valid access URL.
 */
export class SimpleFinClaimError extends SimpleFinError {
  constructor(message: string) {
    super(message, { code: 'local.claim_failed' })
    this.name = 'SimpleFinClaimError'
    Object.setPrototypeOf(this, SimpleFinClaimError.prototype)
  }
}
