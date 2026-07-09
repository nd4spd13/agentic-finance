/**
 * `FinancialDataProvider` backed by the SimpleFIN Bridge (SF5).
 *
 * Implements the same provider interface `plaid-adapter/src/adapter.ts`
 * implements, composing `claim.ts` (out of band — see below), `client.ts`,
 * `mapping.ts`, and `cache.ts` from this package, plus the shared
 * `SqliteTokenStore` from `@clad/core` (see that module's header comment for
 * why it moved out of `@clad/plaid-adapter` in this same task).
 *
 * The biggest structural difference from `PlaidAdapter` is *when* a live
 * network call happens. Plaid's adapter calls the API on every read and only
 * degrades to its cache reactively, on failure — Plaid has no meaningful
 * request-rate ceiling for a single Item. SimpleFIN's Bridge allows roughly
 * 24 `/accounts` requests per day (protocol reference in the plan doc), so
 * this adapter checks `SimpleFinCache.shouldRefresh(itemId)` *before* ever
 * calling the network, and only fetches when the cache says a refresh is
 * actually due (first-ever fetch, or `minRefreshIntervalMs` — default 6h —
 * elapsed since the last one). Every read otherwise serves straight from the
 * cache, which is why `cache.ts`'s staleness bookkeeping is load-bearing
 * here in a way it isn't for Plaid: most calls in normal operation *are*
 * cache reads, not degraded fallbacks.
 *
 * There is no `SimpleFinClientLike`-style injectable SDK client the way
 * `PlaidAdapterOptions.client` is: SimpleFIN has no persistent client/session
 * object to construct (`client.ts`'s `fetchAccounts` is a stateless function
 * that takes the access URL and an injectable `fetch` per call, since HTTP
 * basic auth is derived from the access URL itself on every request). Tests
 * inject a fake `fetch` instead, matching every other test file in this
 * package.
 *
 * No `SimpleFinAdapter.getBalance` "single-account" shortcut exists on the
 * wire either: `/accounts` always returns every account under an item in one
 * response (there's a `balances-only=1` param, but it's still item-wide).
 * `getBalance`/`getTransactions` therefore refresh *every due* stored item —
 * exactly like `getAccounts` — rather than trying to resolve just the one
 * owning item first, which would be impossible on a cold cache anyway (we
 * don't know which item owns an account until we've fetched at least once).
 * This costs nothing extra: due-ness is still checked per item, so an
 * already-fresh item is never re-fetched just because a caller asked about
 * one of its accounts.
 *
 * `getRecurringCharges` is intentionally **not implemented** — it's optional
 * on `FinancialDataProvider` for exactly this reason, and SimpleFIN's
 * protocol has no analog to Plaid's `/transactions/recurring/get` (no
 * recurring-charge detection of any kind). `clad_safe_to_spend`'s handler
 * already guards this call behind `if (context.provider.getRecurringCharges)`,
 * so omitting it here degrades that one tool gracefully rather than serving
 * fabricated data.
 *
 * On every live fetch, this adapter requests the protocol's maximum allowed
 * window (90 days, `MAX_WINDOW_SECONDS` from `client.ts`) and `pending: true`
 * — not because every caller needs 90 days of history, but because
 * `SimpleFinCache.recordFetch` *replaces* (never merges) an item's cached
 * transactions on every successful fetch (see that module's header comment).
 * Requesting a narrow window on a rare, quota-limited fetch would silently
 * delete previously-cached history that is still valid upstream, just not
 * present in that request's window. Widest-window-every-time is the only
 * choice consistent with full-replace eviction semantics.
 *
 * Security: the access URL is a credential. It only ever exists as a local
 * variable in `refreshItemIfDue`, retrieved from `tokenStore.getAccessToken`
 * and passed straight to `fetchAccounts`; it is never logged, never stored
 * on `this`, and never interpolated into an error message anywhere in this
 * file (matches the same discipline `claim.ts`/`client.ts` already apply).
 */

import {
  ProviderAuthError,
  ProviderUnavailableError,
  redactSecrets,
  type Account,
  type Balance,
  type FinancialDataProvider,
  type StoredItemMeta,
  type TokenStore,
  type Transaction,
  type TransactionQueryOpts,
} from '@clad/core'
import { SimpleFinCache } from './cache.js'
import {
  fetchAccounts,
  MAX_WINDOW_SECONDS,
  type FetchLike,
} from './client.js'
import { SimpleFinAccessTokenError, SimpleFinError, SimpleFinSubscriptionError } from './errors.js'
import { mapAccountSet } from './mapping.js'

export interface SimpleFinAdapterOptions {
  /** Stores/decrypts each item's SimpleFIN access URL (the "token"). */
  tokenStore: TokenStore
  /** Path to the SQLite cache DB. Safe to share with `tokenStore`'s DB file — distinct tables, no collisions (mirrors `PlaidAdapter`'s convention). */
  dbPath: string
  /**
   * Fetch implementation used for every `/accounts` call. Defaults to
   * `globalThis.fetch`. Unit tests must always supply a fake here — no test
   * in this package touches the network.
   */
  fetch?: FetchLike
  /** Forwarded to `SimpleFinCache`; default 6h. See that module for the quota-guardrail rationale. */
  minRefreshIntervalMs?: number
  /** Injectable clock, forwarded to `SimpleFinCache` and used for this adapter's own date-window computation. Defaults to `() => new Date()`. */
  now?: () => Date
  userId?: string
}

export class SimpleFinAdapter implements FinancialDataProvider {
  private readonly tokenStore: TokenStore
  private readonly cache: SimpleFinCache
  private readonly fetchImpl: FetchLike | undefined
  private readonly now: () => Date
  private readonly userId: string | undefined

  constructor(options: SimpleFinAdapterOptions) {
    this.tokenStore = options.tokenStore
    this.fetchImpl = options.fetch
    this.now = options.now ?? (() => new Date())
    this.userId = options.userId
    this.cache = new SimpleFinCache({
      dbPath: options.dbPath,
      minRefreshIntervalMs: options.minRefreshIntervalMs,
      now: this.now,
    })
  }

  async getAccounts(_userId: string): Promise<Account[]> {
    const items = this.tokenStore.listItems()
    const accounts: Account[] = []
    let anyFailure = false
    let lastError: unknown

    for (const item of items) {
      try {
        await this.refreshItemIfDue(item)
      } catch (error) {
        if (error instanceof ProviderAuthError) throw error
        anyFailure = true
        lastError = error
      }
      accounts.push(
        ...this.cache.getAccounts(item.itemId).map(({ itemId: _itemId, ...account }) => account)
      )
    }

    if (accounts.length === 0 && anyFailure) {
      throw new ProviderUnavailableError(
        `Unable to reach SimpleFIN and no cached accounts are available: ${describeError(lastError)}`
      )
    }
    return accounts
  }

  async getBalance(_userId: string, accountId: string): Promise<Balance> {
    const { anyFailure, lastError } = await this.refreshAllDueItems()

    const cached = this.cache.getAccount(accountId)
    if (!cached) {
      throw new ProviderUnavailableError(
        anyFailure
          ? `Unable to reach SimpleFIN and no cached balance is available for account ${accountId}: ${describeError(lastError)}`
          : `No SimpleFIN account is associated with ${accountId}.`
      )
    }

    const staleness = this.cache.getStaleness(cached.itemId)
    return {
      account_id: cached.id,
      current: cached.balance_current,
      available: cached.balance_available,
      currency: cached.currency,
      last_updated: staleness.lastFetchedAt ?? this.now().toISOString(),
      ...(cached.stale ? { stale: true } : {}),
    }
  }

  async getTransactions(
    _userId: string,
    accountId: string,
    opts?: TransactionQueryOpts
  ): Promise<Transaction[]> {
    const { anyFailure, lastError } = await this.refreshAllDueItems()

    const cached = this.cache
      .getTransactionsByAccount(accountId, opts)
      .map(({ itemId: _itemId, ...transaction }) => transaction)
    if (cached.length === 0 && anyFailure) {
      throw new ProviderUnavailableError(
        `Unable to reach SimpleFIN and no cached transactions are available for account ${accountId}: ${describeError(lastError)}`
      )
    }
    return cached
  }

  // Deliberately no getRecurringCharges — see the module doc comment.

  // -----------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------

  /**
   * Refreshes every stored item that is due (per the quota guardrail),
   * swallowing non-auth errors so callers can degrade to whatever the cache
   * already has. Used by `getBalance`/`getTransactions`, which — unlike
   * `getAccounts` — don't know up front which single item owns the account
   * they were asked about (impossible to know on a cold cache), so they
   * refresh every due item just like `getAccounts` does.
   */
  private async refreshAllDueItems(): Promise<{ anyFailure: boolean; lastError: unknown }> {
    const items = this.tokenStore.listItems()
    let anyFailure = false
    let lastError: unknown

    for (const item of items) {
      try {
        await this.refreshItemIfDue(item)
      } catch (error) {
        if (error instanceof ProviderAuthError) throw error
        anyFailure = true
        lastError = error
      }
    }
    return { anyFailure, lastError }
  }

  /**
   * Fetches and caches one item's accounts/transactions if — and only if —
   * `SimpleFinCache.shouldRefresh` says a live fetch is due. A no-op
   * otherwise: the whole point of the quota guardrail is that most calls
   * take this early return and never touch the network.
   *
   * Requests the widest protocol-allowed window and `pending: true` — see
   * the module doc comment for why. HTTP 403 (`SimpleFinAccessTokenError`,
   * the access URL was rejected/revoked) maps to `ProviderAuthError` so the
   * user is prompted to re-link, mirroring `PlaidAdapter`'s treatment of
   * `ITEM_LOGIN_REQUIRED`. Every other failure (network error, HTTP 402
   * subscription-lapsed, a malformed response) is rethrown as-is for the
   * caller to swallow and degrade to cache — there is nothing structurally
   * broken about previously-cached data just because the *next* live fetch
   * failed.
   */
  private async refreshItemIfDue(item: StoredItemMeta): Promise<void> {
    if (!this.cache.shouldRefresh(item.itemId)) return

    const accessUrl = this.tokenStore.getAccessToken(item.itemId)
    const nowSeconds = Math.floor(this.now().getTime() / 1000)

    let accountSet
    try {
      accountSet = await fetchAccounts(accessUrl, {
        fetch: this.fetchImpl,
        startDate: Math.max(0, nowSeconds - MAX_WINDOW_SECONDS),
        endDate: nowSeconds,
        pending: true,
      })
    } catch (error) {
      if (error instanceof SimpleFinAccessTokenError) {
        throw new ProviderAuthError(
          'SimpleFIN access URL was rejected (HTTP 403); the user must re-link via a new setup token.',
          item.itemId
        )
      }
      throw error
    }

    const { accounts, transactions } = mapAccountSet(accountSet)
    this.cache.recordFetch(item.itemId, accounts, transactions)
  }
}

/**
 * Produces a description of an unknown error safe to embed in a thrown
 * message. `SimpleFinError` subclasses already redact their own message at
 * construction (see `errors.ts`), so their `.message` is safe to reuse
 * as-is; a `SimpleFinSubscriptionError` (HTTP 402) gets a friendlier,
 * more actionable description since it's a real, protocol-documented
 * failure mode unique to this provider (SimpleFIN Bridge is a paid,
 * user-funded service). Any other error's message is passed through
 * `redactSecrets` defensively before being embedded.
 */
function describeError(error: unknown): string {
  if (error instanceof SimpleFinSubscriptionError) {
    return 'the SimpleFIN Bridge subscription appears to have lapsed (HTTP 402); it must be renewed before this connection can fetch data again'
  }
  if (error instanceof SimpleFinError) return error.message
  if (error instanceof Error) return redactSecrets(error.message)
  return 'unknown error'
}
