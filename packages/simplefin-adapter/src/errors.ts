/**
 * Error hierarchy for the SimpleFIN Bridge adapter.
 *
 * `SimpleFinError` is the common base every SimpleFIN-specific error extends.
 * It carries a `code` string so callers can branch on failure category
 * without parsing message text, and defensively passes every message through
 * `redactSecrets` from `@clad/core` before it becomes `Error#message` — the
 * same discipline `plaid-adapter/src/errors.ts` uses for `LinkFlowError`.
 *
 * SF2 only needed the token-decode and claim-POST failure modes
 * ({@link SimpleFinTokenError}, {@link SimpleFinClaimError}). SF3
 * (`client.ts`, `GET /accounts`) extends the hierarchy with three families:
 *
 * - **Local/client-side** (`local.*`): {@link SimpleFinRequestError} (a
 *   request could not even be built — bad access URL, invalid date window)
 *   and {@link SimpleFinNetworkError} (the request could not be sent at
 *   all). {@link SimpleFinResponseError} covers a 2xx body that isn't a
 *   valid `AccountSet`.
 * - **HTTP transport** (`http.<status>`): {@link SimpleFinHttpError} wraps
 *   any non-2xx response; its subclasses {@link SimpleFinSubscriptionError}
 *   (402) and {@link SimpleFinAccessTokenError} (403) give the two
 *   protocol-documented statuses their own class per the plan's "Protocol
 *   reference" section.
 * - **Protocol payload** (`gen.`/`con.`/`act.`): {@link SimpleFinProtocolError}
 *   wraps a single entry from the response body's `errlist`/`errors` array;
 *   its subclasses {@link SimpleFinGeneralError}, {@link SimpleFinConnectionError},
 *   and {@link SimpleFinAccountError} correspond to the three documented
 *   prefixes. An entry whose subcode isn't individually recognized still
 *   lands in the right subclass (its prefix determines the class, not the
 *   specific subcode) — see `client.ts`'s `parseProtocolError`. These are
 *   *not* thrown automatically by `fetchAccounts` on a 200 response (the
 *   array can carry non-fatal warnings, e.g. rate-limit notices, alongside
 *   otherwise-valid account data); they are attached to the parsed
 *   `AccountSet` as typed instances for the caller to inspect or escalate.
 *
 * Security invariant: no constructor here ever interpolates the SimpleFIN
 * access URL (or any string that might carry it, such as a raw response
 * body) into a message. `claim.ts`/`client.ts` are responsible for only ever
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

/**
 * Thrown when a `GET /accounts` request cannot even be built: the access URL
 * is not a well-formed `http(s)` URL, it is missing its embedded basic-auth
 * userinfo (`https://user:pass@host/...`), or a caller-supplied `start-date`/
 * `end-date` window is invalid (`end-date` before `start-date`, or a span
 * longer than the protocol's confirmed 90-day maximum per request). Thrown
 * before any network call, so it never carries a real HTTP status.
 */
export class SimpleFinRequestError extends SimpleFinError {
  constructor(message: string) {
    super(message, { code: 'local.invalid_request' })
    this.name = 'SimpleFinRequestError'
    Object.setPrototypeOf(this, SimpleFinRequestError.prototype)
  }
}

/**
 * Thrown when the `GET /accounts` request cannot reach the Bridge: no
 * injectable/global `fetch` implementation is available, or the `fetch` call
 * itself rejected (DNS/connection failure, timeout, etc.). Like
 * `SimpleFinClaimError`, never interpolates the caught error's message —
 * `fetch` network-failure messages can embed the request URL.
 */
export class SimpleFinNetworkError extends SimpleFinError {
  constructor(message: string) {
    super(message, { code: 'local.network_error' })
    this.name = 'SimpleFinNetworkError'
    Object.setPrototypeOf(this, SimpleFinNetworkError.prototype)
  }
}

/**
 * Thrown when a 2xx `/accounts` response cannot be parsed as an `AccountSet`:
 * the body is not valid JSON, is not a JSON object, or is missing/mistypes a
 * required field (e.g. `accounts` not an array, an account's `balance` not a
 * string). Never echoes the raw response body into the message — only a
 * static description of which field failed validation.
 */
export class SimpleFinResponseError extends SimpleFinError {
  constructor(message: string) {
    super(message, { code: 'local.invalid_response' })
    this.name = 'SimpleFinResponseError'
    Object.setPrototypeOf(this, SimpleFinResponseError.prototype)
  }
}

/**
 * Base class for a non-2xx HTTP response from `/accounts`. Carries the raw
 * HTTP `status` alongside the `code` string so callers can branch on either.
 * Thrown directly (rather than as one of its subclasses) for any status
 * other than 402/403, with `code` set to `http.<status>`.
 */
export class SimpleFinHttpError extends SimpleFinError {
  readonly status: number

  constructor(message: string, status: number, code: string = `http.${status}`) {
    super(message, { code })
    this.name = 'SimpleFinHttpError'
    this.status = status
    Object.setPrototypeOf(this, SimpleFinHttpError.prototype)
  }
}

/**
 * HTTP 402 from `/accounts`. Per the plan's protocol reference this means
 * the Bridge subscription has lapsed — SimpleFIN Bridge is a paid,
 * user-funded service (see the plan's "Why SimpleFIN" section) — and the
 * user must renew it before this connection can fetch data again.
 */
export class SimpleFinSubscriptionError extends SimpleFinHttpError {
  constructor(message: string) {
    super(message, 402, 'http.402')
    this.name = 'SimpleFinSubscriptionError'
    Object.setPrototypeOf(this, SimpleFinSubscriptionError.prototype)
  }
}

/**
 * HTTP 403 from `/accounts`. Per the plan's protocol reference this means
 * the access URL's credentials are invalid, were revoked, or may be
 * compromised — a failure of the *whole* access token, distinct from a
 * single connection's `con.auth` protocol-level issue (see
 * {@link SimpleFinConnectionError}). Re-linking via a new setup token is
 * required to recover.
 */
export class SimpleFinAccessTokenError extends SimpleFinHttpError {
  constructor(message: string) {
    super(message, 403, 'http.403')
    this.name = 'SimpleFinAccessTokenError'
    Object.setPrototypeOf(this, SimpleFinAccessTokenError.prototype)
  }
}

/**
 * Base class for a single entry from the `AccountSet`'s error array
 * (`errlist`, confirmed live in SF1; `errors` tolerated defensively — see
 * `client.ts`). These arrive alongside an HTTP 200 response and are not
 * necessarily fatal (e.g. a rate-limit warning per the plan's "Rate limits"
 * note) — `fetchAccounts` never throws these automatically; they are
 * attached to the parsed `AccountSet` as typed instances for the caller to
 * inspect, log, or escalate. Carries `subcode`, the full dotted code (e.g.
 * `con.auth`) that the entry matched, or `gen.unspecified` if the entry
 * didn't match the documented `gen./con./act.` pattern at all.
 */
export class SimpleFinProtocolError extends SimpleFinError {
  readonly subcode: string

  constructor(message: string, code: string) {
    super(message, { code })
    this.name = 'SimpleFinProtocolError'
    this.subcode = code
    Object.setPrototypeOf(this, SimpleFinProtocolError.prototype)
  }
}

/**
 * A `gen.*` protocol error entry — a general/unscoped issue not tied to a
 * specific connection or account. Also used as the catch-all for an entry
 * that doesn't match the documented `gen./con./act.` prefix pattern at all
 * (code `gen.unspecified`), and for any *unrecognized* `gen.*` subcode
 * (unknown subcodes degrade to their prefix category, never further).
 */
export class SimpleFinGeneralError extends SimpleFinProtocolError {
  constructor(message: string, code: string) {
    super(message, code)
    this.name = 'SimpleFinGeneralError'
    Object.setPrototypeOf(this, SimpleFinGeneralError.prototype)
  }
}

/**
 * A `con.*` protocol error entry — an issue scoped to a specific institution
 * connection (e.g. `con.auth`: re-authentication is needed at the
 * institution). An unrecognized `con.*` subcode still lands here with its
 * raw code preserved in `subcode`.
 */
export class SimpleFinConnectionError extends SimpleFinProtocolError {
  constructor(message: string, code: string) {
    super(message, code)
    this.name = 'SimpleFinConnectionError'
    Object.setPrototypeOf(this, SimpleFinConnectionError.prototype)
  }
}

/**
 * An `act.*` protocol error entry — an issue scoped to a specific account.
 * An unrecognized `act.*` subcode still lands here with its raw code
 * preserved in `subcode`.
 */
export class SimpleFinAccountError extends SimpleFinProtocolError {
  constructor(message: string, code: string) {
    super(message, code)
    this.name = 'SimpleFinAccountError'
    Object.setPrototypeOf(this, SimpleFinAccountError.prototype)
  }
}
