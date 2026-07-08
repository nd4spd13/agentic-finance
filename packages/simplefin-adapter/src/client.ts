/**
 * SimpleFIN Bridge `GET /accounts` client and response parsing (SF3).
 *
 * Given an access URL (as returned by `claim.ts`), builds and issues a
 * `GET {accessUrl}/accounts` request per the protocol reference verified in
 * SF1 (`packages/docs/plans/simplefin-adapter.md`), and validates the
 * response body into the real (v2) `AccountSet` shape confirmed against the
 * captured fixtures in `test/fixtures/`.
 *
 * Key protocol facts this file encodes (see the plan doc for the full
 * writeup):
 * - The access URL's basic-auth userinfo (`https://user:pass@host/...`) is
 *   the actual credential. `fetch()` implementations (undici, browsers)
 *   *reject* URLs that carry embedded credentials, so this module always
 *   strips the userinfo before building the request URL and instead sends
 *   it as a `Basic` `Authorization` header — this is a functional
 *   requirement, not just a redaction nicety.
 * - `start-date`/`end-date` are Unix epoch seconds; the protocol caps the
 *   window at 90 days per request. This client *rejects* (throws) a window
 *   that exceeds that cap rather than silently clamping it — see
 *   `validateDateWindow` for why.
 * - v2 accounts carry `conn_id` only (no `org`); organization identity is
 *   resolved by the caller by joining against the top-level `connections[]`
 *   array, which is always present.
 * - `balances-only=1` returns `transactions`/`holdings` as empty arrays, not
 *   omitted keys — this module never uses key presence to detect response
 *   shape.
 * - The response's error array is `errlist` in every real (SF1) capture;
 *   `errors` is tolerated defensively per the developers guide's own
 *   inconsistent wording, even though it was never observed live. Entries
 *   are parsed into typed `SimpleFinProtocolError` instances but are *not*
 *   thrown automatically — see `parseProtocolError` and `SimpleFinProtocolError`.
 * - Amounts/balances/holding figures are numeric strings and are never
 *   parsed to floats anywhere in this file.
 *
 * Injectable `fetch` (same pattern as `claim.ts`) — no test in this package
 * touches the network.
 */

import {
  SimpleFinAccessTokenError,
  SimpleFinAccountError,
  SimpleFinConnectionError,
  SimpleFinError,
  SimpleFinGeneralError,
  SimpleFinHttpError,
  SimpleFinNetworkError,
  SimpleFinProtocolError,
  SimpleFinRequestError,
  SimpleFinResponseError,
  SimpleFinSubscriptionError,
} from './errors.js'

/** The shape of the global `fetch` function, injectable for tests. */
export type FetchLike = typeof fetch

/** A SimpleFIN v2 investment holding, undocumented in the protocol spec text but observed on every live account in SF1 (see the plan's "Discrepancies found in SF1" #3). */
export interface SimpleFinHolding {
  id: string
  created?: number
  /** Numeric string — never parsed to a float. */
  cost_basis?: string
  currency?: string
  description?: string
  /** Numeric string — never parsed to a float. */
  market_value?: string
  /** Numeric string — never parsed to a float. */
  purchase_price?: string
  /** Numeric string — never parsed to a float. */
  shares?: string
  symbol?: string
}

/** A SimpleFIN v2 transaction. */
export interface SimpleFinTransaction {
  id: string
  /** Unix epoch seconds. */
  posted: number
  /** Numeric string, signed (e.g. `"-45.50"`) — never parsed to a float. */
  amount: string
  description: string
  /** Undocumented in the protocol spec text but present on every live transaction in SF1. */
  payee?: string
  /** Undocumented in the protocol spec text but present on every live transaction in SF1. */
  memo?: string
  /** Unix epoch seconds. */
  transacted_at?: number
  /** Documented (`pending=1` requests these) but never observed live in SF1. */
  pending?: boolean
  extra?: unknown
}

/**
 * A SimpleFIN v2 account. Field names mirror the wire format exactly
 * (including the kebab-case `available-balance`/`balance-date` keys) so this
 * type is a faithful, directly-inspectable record of the real `AccountSet`
 * shape — mapping to `@clad/core` models is `mapping.ts`'s job (SF4), not
 * this file's.
 */
export interface SimpleFinAccount {
  id: string
  name: string
  /** ISO 4217 code in every SF1 capture; the protocol also allows a custom-currency URL (unconfirmed live — see the plan's discrepancies). */
  currency: string
  /** Numeric string — never parsed to a float. */
  balance: string
  /** Numeric string — never parsed to a float. */
  'available-balance': string
  /** Unix epoch seconds. */
  'balance-date': number
  /** Empty (not omitted) under `balances-only=1`. */
  transactions: SimpleFinTransaction[]
  /** Empty (not omitted) under `balances-only=1`. Undocumented in the protocol spec text — see the plan's discrepancies. */
  holdings: SimpleFinHolding[]
  /** v2 only: joins against the top-level `connections[]` array. There is no `org` field in v2. */
  conn_id: string
  extra?: unknown
}

/** A SimpleFIN v2 connection (institution link), always present as a top-level sibling of `accounts[]`. */
export interface SimpleFinConnection {
  conn_id: string
  name?: string
  org_id?: string
  /** Observed live in SF1; not mentioned in the developers guide's spec text for `Connection`. */
  org_name?: string
  org_url?: string
  sfin_url?: string
}

/**
 * The parsed `GET /accounts` response. `errors` normalizes whichever of
 * `errlist`/`errors` the server sent (merged if, improbably, both are
 * present) into typed {@link SimpleFinProtocolError} instances — see that
 * class's doc comment for why these are not thrown automatically.
 * `apiMessages` normalizes the undocumented top-level `x-api-message` array
 * (informational hints, e.g. "provide a start-date...").
 */
export interface SimpleFinAccountSet {
  accounts: SimpleFinAccount[]
  connections: SimpleFinConnection[]
  errors: SimpleFinProtocolError[]
  apiMessages: string[]
}

/** Options for {@link fetchAccounts}. */
export interface FetchAccountsOptions {
  /**
   * Fetch implementation to use for the request. Defaults to
   * `globalThis.fetch`. Unit tests must always supply a fake here — no test
   * in this package should touch the network.
   */
  fetch?: FetchLike
  /** Start of the date window, Unix epoch seconds (inclusive, per protocol). */
  startDate?: number
  /** End of the date window, Unix epoch seconds (inclusive, per protocol). */
  endDate?: number
  /** Include pending transactions (excluded by default). */
  pending?: boolean
  /** Restrict the response to these account ids. Repeatable per protocol (`account={id}`). */
  accountIds?: string[]
  /** Balances only — the server still returns `transactions`/`holdings` as empty arrays, never omitted. */
  balancesOnly?: boolean
}

/** The protocol's confirmed maximum `start-date`/`end-date` span, in seconds. */
const MAX_WINDOW_SECONDS = 90 * 24 * 60 * 60

const PROTOCOL_CODE_PATTERN = /^(gen|con|act)\.([a-z0-9_-]+)/i

/**
 * Issues `GET {accessUrl}/accounts` and resolves with the parsed
 * `AccountSet`. Throws {@link SimpleFinRequestError} if the request cannot
 * be built (bad access URL, invalid date window), {@link SimpleFinNetworkError}
 * if it cannot be sent, a {@link SimpleFinHttpError} subclass for a non-2xx
 * response, or {@link SimpleFinResponseError} if a 2xx body doesn't parse as
 * a valid `AccountSet`.
 */
export async function fetchAccounts(
  accessUrl: string,
  options: FetchAccountsOptions = {}
): Promise<SimpleFinAccountSet> {
  const { url, authorizationHeader } = buildAccountsRequest(accessUrl, options)

  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new SimpleFinNetworkError(
      'No fetch implementation is available; pass options.fetch explicitly.'
    )
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: authorizationHeader },
    })
  } catch {
    // Deliberately does not include the caught error's message: fetch
    // network-failure messages can embed the request URL (see claim.ts for
    // the same discipline).
    throw new SimpleFinNetworkError('Failed to reach the SimpleFIN accounts endpoint.')
  }

  if (!response.ok) {
    // Drain the body so the connection can be released, but never surface
    // its contents in the thrown error: an error body could itself echo
    // request/account details.
    await response.text().catch(() => undefined)
    throw mapHttpError(response.status)
  }

  const bodyText = await response.text()

  let json: unknown
  try {
    json = JSON.parse(bodyText)
  } catch {
    throw new SimpleFinResponseError('SimpleFIN accounts response was not valid JSON.')
  }

  return parseAccountSet(json)
}

/**
 * Builds the request URL and `Authorization` header for a `GET /accounts`
 * call, without performing any I/O. Exported so param-building/validation
 * can be unit-tested without mocking `fetch`.
 *
 * The returned `url` never carries userinfo: basic-auth credentials are
 * parsed out of the access URL and returned separately as a `Basic`
 * `Authorization` header, both because `fetch()` implementations reject
 * credentialed URLs outright and because the security invariant that the
 * access URL never appears (with userinfo) in a log or error is easiest to
 * uphold when no code path downstream of this function ever sees it.
 */
export function buildAccountsRequest(
  accessUrl: string,
  options: FetchAccountsOptions = {}
): { url: string; authorizationHeader: string } {
  let parsed: URL
  try {
    parsed = new URL(accessUrl)
  } catch {
    throw new SimpleFinRequestError('SimpleFIN access URL is not a valid URL.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SimpleFinRequestError('SimpleFIN access URL must use the http or https scheme.')
  }

  const username = decodeURIComponent(parsed.username)
  const password = decodeURIComponent(parsed.password)
  if (!username || !password) {
    throw new SimpleFinRequestError(
      'SimpleFIN access URL is missing its embedded basic-auth credentials.'
    )
  }
  const authorizationHeader = `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`

  // Strip the userinfo before this URL is used anywhere else (request
  // target, error messages, logs).
  parsed.username = ''
  parsed.password = ''

  const basePath = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = `${basePath}/accounts`
  parsed.search = buildQueryParams(options).toString()

  return { url: parsed.toString(), authorizationHeader }
}

function buildQueryParams(options: FetchAccountsOptions): URLSearchParams {
  const params = new URLSearchParams()
  params.set('version', '2')

  if (options.startDate !== undefined && options.endDate !== undefined) {
    validateDateWindow(options.startDate, options.endDate)
  }
  if (options.startDate !== undefined) {
    params.set('start-date', String(assertEpochSeconds(options.startDate, 'startDate')))
  }
  if (options.endDate !== undefined) {
    params.set('end-date', String(assertEpochSeconds(options.endDate, 'endDate')))
  }
  if (options.pending) {
    params.set('pending', '1')
  }
  if (options.balancesOnly) {
    params.set('balances-only', '1')
  }
  for (const accountId of options.accountIds ?? []) {
    params.append('account', accountId)
  }

  return params
}

/**
 * Enforces the protocol's confirmed 90-day maximum `start-date`/`end-date`
 * window by *rejecting* (throwing) an over-wide window rather than silently
 * clamping it. A silent clamp would return less data than the caller asked
 * for with no signal that anything was cut — a caller paging through
 * transaction history in >90-day strides would silently and permanently
 * lose data at each boundary. Throwing surfaces the mistake immediately, at
 * the exact call site, so the caller can split the request into multiple
 * windows itself.
 */
function validateDateWindow(startDate: number, endDate: number): void {
  if (endDate < startDate) {
    throw new SimpleFinRequestError(
      'SimpleFIN accounts request end-date must not be before start-date.'
    )
  }
  if (endDate - startDate > MAX_WINDOW_SECONDS) {
    throw new SimpleFinRequestError(
      'SimpleFIN accounts request date window exceeds the protocol’s 90-day maximum ' +
        'per request; split it into multiple requests instead.'
    )
  }
}

function assertEpochSeconds(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new SimpleFinRequestError(
      `SimpleFIN accounts request "${label}" must be a non-negative integer (Unix epoch seconds).`
    )
  }
  return value
}

function mapHttpError(status: number): SimpleFinError {
  switch (status) {
    case 402:
      return new SimpleFinSubscriptionError(
        'SimpleFIN accounts request failed: HTTP 402 Payment Required. The Bridge ' +
          'subscription appears to have lapsed; the user must renew it at the Bridge ' +
          'before this connection can fetch data again.'
      )
    case 403:
      return new SimpleFinAccessTokenError(
        'SimpleFIN accounts request failed: HTTP 403 Forbidden. The access token is ' +
          'invalid, was revoked, or may be compromised; re-linking via a new setup ' +
          'token is required.'
      )
    default:
      return new SimpleFinHttpError(`SimpleFIN accounts request failed with HTTP ${status}.`, status)
  }
}

/**
 * Converts a single raw `errlist`/`errors` entry into a typed
 * {@link SimpleFinProtocolError}. Entries are documented as structured codes
 * of the form `"<prefix>.<subcode>"` (optionally followed by free text) with
 * `prefix` one of `gen`/`con`/`act` — though this was never observed live in
 * SF1 (every real capture's `errlist` was empty). Defensive against entries
 * that are not strings, or strings that don't match the pattern at all: both
 * degrade to {@link SimpleFinGeneralError} with code `gen.unspecified` — an
 * unrecognized *subcode* under a known prefix still resolves to that
 * prefix's class (see the `switch` below), and an entry with no recognizable
 * prefix at all falls back one level further, into the general/`gen`
 * category itself.
 */
export function parseProtocolError(entry: unknown): SimpleFinProtocolError {
  const text = scrubCredentialedUrls(describeErrorEntry(entry))
  const match = PROTOCOL_CODE_PATTERN.exec(text.trim())

  if (!match) {
    return new SimpleFinGeneralError(
      `SimpleFIN reported an unstructured protocol issue: ${text}`,
      'gen.unspecified'
    )
  }

  const prefix = match[1].toLowerCase()
  const code = `${prefix}.${match[2].toLowerCase()}`
  const message = `SimpleFIN reported a protocol issue (${code}): ${text}`

  switch (prefix) {
    case 'con':
      return new SimpleFinConnectionError(message, code)
    case 'act':
      return new SimpleFinAccountError(message, code)
    default:
      return new SimpleFinGeneralError(message, code)
  }
}

/**
 * Strips `scheme://userinfo@` prefixes (the shape of a SimpleFIN access URL)
 * from arbitrary text before it is embedded in a thrown error message.
 * `errlist`/`errors` entries are free-form server text and are otherwise
 * embedded close to verbatim in {@link parseProtocolError} (to stay useful
 * for diagnostics) — this guards that one spot against a malicious or buggy
 * response trying to echo this client's own credential back into a message
 * that might later be logged. `redactSecrets` (from `@clad/core`) does not
 * cover this pattern; it targets Plaid-style tokens and secret-like JSON
 * `"field": "value"` pairs, not credentialed URLs.
 */
const CREDENTIALED_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+@/gi

function scrubCredentialedUrls(text: string): string {
  return text.replace(CREDENTIALED_URL_PATTERN, '[REDACTED-URL]')
}

function describeErrorEntry(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable error entry]'
  }
}

// ---------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------

/**
 * Validates and normalizes a parsed JSON body into a {@link SimpleFinAccountSet}.
 * Pure (no I/O) and exported so parsing can be exercised directly against a
 * fixture's `JSON.parse`'d contents without going through `fetch` mocking.
 *
 * Required fields are validated by type; unrecognized top-level or
 * per-object keys are ignored rather than causing a failure (the protocol
 * has already been observed live to carry undocumented fields — `holdings`,
 * `payee`/`memo`, `x-api-message` — and a hypothetical future addition
 * should not break parsing of otherwise-valid data).
 */
export function parseAccountSet(json: unknown): SimpleFinAccountSet {
  if (!isRecord(json)) {
    throw new SimpleFinResponseError('SimpleFIN accounts response body was not a JSON object.')
  }

  const accountsRaw = expectArray(json.accounts, 'accounts')
  const accounts = accountsRaw.map((entry, index) => parseAccount(entry, index))

  // `connections[]` is confirmed always-present in v2 (SF1: non-empty in
  // every capture), but still tolerated as absent rather than hard-failing
  // — a missing/renamed `connections[]` shouldn't take down parsing of
  // otherwise-valid account data.
  const connectionsRaw = Array.isArray(json.connections) ? json.connections : []
  const connections = connectionsRaw.map((entry, index) => parseConnection(entry, index))

  // Both `errlist` (confirmed live in every SF1 capture) and `errors` (only
  // ever seen in the developers guide's own inconsistent prose, never in a
  // real response) are parsed defensively; entries from both are merged if,
  // improbably, both keys are present at once.
  const rawErrorEntries = [
    ...(Array.isArray(json.errlist) ? json.errlist : []),
    ...(Array.isArray(json.errors) ? json.errors : []),
  ]
  const errors = rawErrorEntries.map((entry) => parseProtocolError(entry))

  const apiMessagesRaw = json['x-api-message']
  const apiMessages = Array.isArray(apiMessagesRaw)
    ? apiMessagesRaw.filter((entry): entry is string => typeof entry === 'string')
    : []

  return { accounts, connections, errors, apiMessages }
}

function parseAccount(raw: unknown, index: number): SimpleFinAccount {
  const path = `accounts[${index}]`
  if (!isRecord(raw)) {
    throw new SimpleFinResponseError(`SimpleFIN accounts response ${path} was not an object.`)
  }

  const account: SimpleFinAccount = {
    id: expectString(raw.id, `${path}.id`),
    name: expectString(raw.name, `${path}.name`),
    currency: expectString(raw.currency, `${path}.currency`),
    balance: expectString(raw.balance, `${path}.balance`),
    'available-balance': expectString(raw['available-balance'], `${path}.available-balance`),
    'balance-date': expectNumber(raw['balance-date'], `${path}.balance-date`),
    conn_id: expectString(raw.conn_id, `${path}.conn_id`),
    transactions: expectArray(raw.transactions, `${path}.transactions`).map((entry, txIndex) =>
      parseTransaction(entry, path, txIndex)
    ),
    // Present (possibly empty) on every v2 account per SF1, but undocumented
    // in the protocol spec text — default to `[]` rather than failing if a
    // future/alternate server omits it.
    holdings: Array.isArray(raw.holdings)
      ? raw.holdings.map((entry, holdingIndex) => parseHolding(entry, path, holdingIndex))
      : [],
  }
  if (raw.extra !== undefined) {
    account.extra = raw.extra
  }
  return account
}

function parseTransaction(raw: unknown, accountPath: string, index: number): SimpleFinTransaction {
  const path = `${accountPath}.transactions[${index}]`
  if (!isRecord(raw)) {
    throw new SimpleFinResponseError(`SimpleFIN accounts response ${path} was not an object.`)
  }

  const transaction: SimpleFinTransaction = {
    id: expectString(raw.id, `${path}.id`),
    posted: expectNumber(raw.posted, `${path}.posted`),
    amount: expectString(raw.amount, `${path}.amount`),
    description: expectString(raw.description, `${path}.description`),
  }
  const payee = optionalString(raw.payee)
  if (payee !== undefined) transaction.payee = payee
  const memo = optionalString(raw.memo)
  if (memo !== undefined) transaction.memo = memo
  const transactedAt = optionalNumber(raw.transacted_at)
  if (transactedAt !== undefined) transaction.transacted_at = transactedAt
  const pending = optionalBoolean(raw.pending)
  if (pending !== undefined) transaction.pending = pending
  if (raw.extra !== undefined) transaction.extra = raw.extra

  return transaction
}

function parseHolding(raw: unknown, accountPath: string, index: number): SimpleFinHolding {
  const path = `${accountPath}.holdings[${index}]`
  if (!isRecord(raw)) {
    throw new SimpleFinResponseError(`SimpleFIN accounts response ${path} was not an object.`)
  }

  return {
    id: expectString(raw.id, `${path}.id`),
    created: optionalNumber(raw.created),
    cost_basis: optionalString(raw.cost_basis),
    currency: optionalString(raw.currency),
    description: optionalString(raw.description),
    market_value: optionalString(raw.market_value),
    purchase_price: optionalString(raw.purchase_price),
    shares: optionalString(raw.shares),
    symbol: optionalString(raw.symbol),
  }
}

function parseConnection(raw: unknown, index: number): SimpleFinConnection {
  const path = `connections[${index}]`
  if (!isRecord(raw)) {
    throw new SimpleFinResponseError(`SimpleFIN accounts response ${path} was not an object.`)
  }

  return {
    conn_id: expectString(raw.conn_id, `${path}.conn_id`),
    name: optionalString(raw.name),
    org_id: optionalString(raw.org_id),
    org_name: optionalString(raw.org_name),
    org_url: optionalString(raw.org_url),
    sfin_url: optionalString(raw.sfin_url),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new SimpleFinResponseError(
      `SimpleFIN accounts response field "${path}" must be a string.`
    )
  }
  return value
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SimpleFinResponseError(
      `SimpleFIN accounts response field "${path}" must be a number.`
    )
  }
  return value
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SimpleFinResponseError(`SimpleFIN accounts response field "${path}" must be an array.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
