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
 * The 6h interval is the right default for *steady state* and the wrong one
 * for the minutes right after linking, because of a gap with no technical
 * fix available: institutions are linked on the SimpleFIN Bridge's own
 * website, which this app never observes. There is no webhook, no callback,
 * no completion event — the access URL simply starts returning more accounts
 * one day, and nothing tells us when. Two mechanisms compensate, both of
 * them approximations of the event we cannot have:
 *
 *  - **Setup grace window** (`setupGraceMs`, default 1h at 10min intervals):
 *    refresh more eagerly while the account set is still churning, which is
 *    also the exact window the developers guide grants quota leeway for.
 *  - **`forceRefresh()`**: explicit user intent ("Check for new accounts") is
 *    the one signal we do reliably get. Floored at 1 minute and capped by a
 *    rolling daily budget.
 *
 * Neither bypasses the guardrail — both go through `cache.shouldRefresh` with
 * a shorter interval, so an unreadable timestamp still fails closed. And
 * `getRefreshStatus()` exists so callers can *show* the cooldown: a Refresh
 * button that silently no-ops for six hours is indistinguishable from a bug,
 * which is precisely how a missing account went undiagnosed long enough to
 * need a SQLite session to explain.
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

/**
 * How long after an item is first stored the setup grace window lasts. See
 * {@link SimpleFinAdapterOptions.setupGraceMs}.
 */
const DEFAULT_SETUP_GRACE_MS = 60 * 60 * 1000 // 1 hour

/** Refresh interval used inside the setup grace window. */
const DEFAULT_SETUP_GRACE_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * The floor {@link SimpleFinAdapter.forceRefresh} applies. Note this is an
 * *interval*, not a bypass: a force refresh is an ordinary
 * `cache.shouldRefresh` call with a very short interval, so it inherits the
 * gate's fail-closed handling of unreadable timestamps rather than routing
 * around it.
 */
const FORCE_REFRESH_FLOOR_MS = 60 * 1000 // 1 minute

/**
 * Requests per rolling 24h that {@link SimpleFinAdapter.forceRefresh} will
 * spend before refusing. Deliberately below the developers guide's "24
 * requests or fewer per day" so the automatic 6h refreshes (4/item/day) and
 * the initial claim-time fetch always have room — a user mashing "Check for
 * new accounts" must not be able to starve the app's own upkeep or trip the
 * abuse threshold that disables the access URL. The guide describes the cap
 * as soft and its exact scope (per access URL? per Bridge account?) is
 * unverified, which is the other reason to leave headroom.
 */
const FORCE_REFRESH_DAILY_BUDGET = 20

/** Outcome of a user-initiated {@link SimpleFinAdapter.forceRefresh}. Display-safe. */
export interface ForceRefreshResult {
  /** Item ids that made a live request and updated their cache. */
  refreshed: string[]
  /** Item ids skipped because they fetched within the last {@link FORCE_REFRESH_FLOOR_MS}. */
  skipped: string[]
  /** `true` when the daily budget refused at least one item. */
  budgetExhausted: boolean
  /** Requests spent in the rolling 24h window, after this call. */
  requestsInLastDay: number
  /** Display-safe description of a failure that affected at least one item, if any. */
  error?: string
}

/** What the UI needs to explain the cooldown instead of silently no-opping. Display-safe. */
export interface RefreshStatus {
  /** Milliseconds until an automatic refresh is next allowed; `0` when one is due now. */
  msUntilRefreshAllowed: number
  /** `true` while at least one item is inside its post-setup grace window. */
  inSetupGrace: boolean
  /** Requests spent in the rolling 24h window. */
  requestsInLastDay: number
  /** Remaining force-refresh budget in the rolling 24h window. */
  forceRefreshBudgetRemaining: number
}

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
  /**
   * How long after an item's `createdAt` the shorter {@link
   * setupGraceIntervalMs} applies instead of `minRefreshIntervalMs`.
   * Defaults to 1 hour; `0` disables the grace window.
   *
   * Why this exists: linking institutions happens on the *Bridge's* website,
   * which this app never observes — there is no webhook, no callback, no
   * completion event to hook. The claim-time fetch therefore snapshots the
   * account set at the least representative moment possible (before the user
   * has finished adding institutions) and, with only the 6h interval, that
   * snapshot is then frozen in for six hours. A user who links another bank
   * ten minutes later has no way to see it and no way to know why. Refreshing
   * a little more eagerly during the window where the account set is actually
   * churning is the closest honest substitute for the event we cannot get,
   * and it is the exact case the developers guide grants leeway for ("a
   * little leeway above this limit ... helpful when doing initial setup").
   * Bounded by construction: 1h at 10min intervals is at most 6 extra
   * requests per item, once, and only ever right after linking.
   */
  setupGraceMs?: number
  /** Refresh interval used inside {@link setupGraceMs}; defaults to 10 minutes. */
  setupGraceIntervalMs?: number
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
  private readonly setupGraceMs: number
  private readonly setupGraceIntervalMs: number

  constructor(options: SimpleFinAdapterOptions) {
    this.tokenStore = options.tokenStore
    this.fetchImpl = options.fetch
    this.now = options.now ?? (() => new Date())
    this.userId = options.userId
    this.setupGraceMs = options.setupGraceMs ?? DEFAULT_SETUP_GRACE_MS
    this.setupGraceIntervalMs = options.setupGraceIntervalMs ?? DEFAULT_SETUP_GRACE_INTERVAL_MS
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

  /**
   * Releases the SQLite cache handle this adapter opened in its constructor.
   * The injected `tokenStore` is NOT closed here — the adapter received it,
   * it doesn't own it, and the caller that constructed it (e.g. the desktop
   * main process) closes it on its own timeline. Idempotent-safe to call once
   * per constructed adapter; required for the construct-use-dispose callers
   * (a per-IPC-call adapter would otherwise leak a file handle each click).
   * The long-lived dashboard provider simply never calls it, which is fine —
   * the handle lives as long as the process, as it did before.
   */
  close(): void {
    this.cache.close()
  }

  // -----------------------------------------------------------------
  // User-initiated refresh
  // -----------------------------------------------------------------

  /**
   * Refreshes every stored item on explicit user request ("Check for new
   * accounts"), subject to a 1-minute floor and the daily budget — the
   * closest honest substitute for the Bridge-side "you linked something"
   * event that does not exist (see {@link
   * SimpleFinAdapterOptions.setupGraceMs}). Explicit user intent is the one
   * signal we do get that the account set may have changed, so it is worth a
   * request the interval gate would otherwise refuse.
   *
   * NOT a bypass. It runs the same `cache.shouldRefresh` gate with a very
   * short interval, so an unreadable timestamp still fails closed exactly as
   * it would for an automatic refresh. The only thing being relaxed is *how
   * long*, never *whether the gate applies*.
   *
   * Never throws: a per-item failure lands in `error` (secret-free) while
   * every other item still gets its chance, mirroring `getAccounts`'s
   * degrade-to-cache posture. `ProviderAuthError` is the one exception worth
   * propagating — a rejected access URL is not a transient failure and the
   * user must be told to re-link.
   */
  async forceRefresh(): Promise<ForceRefreshResult> {
    const items = this.tokenStore.listItems()
    const refreshed: string[] = []
    const skipped: string[] = []
    let budgetExhausted = false
    let lastError: unknown

    for (const item of items) {
      if (!this.cache.shouldRefresh(item.itemId, { intervalMs: FORCE_REFRESH_FLOOR_MS })) {
        skipped.push(item.itemId)
        continue
      }

      // Checked per item, immediately before spending: a multi-item account
      // could otherwise cross the budget partway through this loop.
      if (this.cache.requestsInLastDay() >= FORCE_REFRESH_DAILY_BUDGET) {
        budgetExhausted = true
        break
      }

      try {
        await this.refreshItemIfDue(item, FORCE_REFRESH_FLOOR_MS)
        refreshed.push(item.itemId)
      } catch (error) {
        if (error instanceof ProviderAuthError) throw error
        lastError = error
      }
    }

    return {
      refreshed,
      skipped,
      budgetExhausted,
      requestsInLastDay: this.cache.requestsInLastDay(),
      ...(lastError ? { error: describeError(lastError) } : {}),
    }
  }

  /**
   * What the UI needs to explain the cooldown rather than leave a Refresh
   * button that silently does nothing — the failure mode that made a missing
   * account effectively undiagnosable. Pure cache reads; never touches the
   * network.
   *
   * `msUntilRefreshAllowed` is reported for the item that will come due
   * *soonest*, since that is when the next automatic refresh could surface
   * anything new.
   */
  getRefreshStatus(): RefreshStatus {
    const items = this.tokenStore.listItems()
    const waits = items.map((item) =>
      this.cache.msUntilRefreshAllowed(item.itemId, { intervalMs: this.setupGraceIntervalFor(item) })
    )

    return {
      msUntilRefreshAllowed: waits.length > 0 ? Math.min(...waits) : 0,
      inSetupGrace: items.some((item) => this.setupGraceIntervalFor(item) !== undefined),
      requestsInLastDay: this.cache.requestsInLastDay(),
      forceRefreshBudgetRemaining: Math.max(
        0,
        FORCE_REFRESH_DAILY_BUDGET - this.cache.requestsInLastDay()
      ),
    }
  }

  // -----------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------

  /**
   * The shorter grace interval while an item is still within
   * `setupGraceMs` of being stored, or `undefined` to use the cache's
   * normal interval.
   *
   * Returns `undefined` for an unreadable or future-dated `createdAt` rather
   * than guessing: the same "an age we cannot compute is never grounds to
   * spend a request" rule the cache's gate follows. Falling back to the
   * normal 6h interval is the conservative direction here — the worst case is
   * a user waits, not that a broken clock unlocks 10-minute polling forever.
   */
  private setupGraceIntervalFor(item: StoredItemMeta): number | undefined {
    if (this.setupGraceMs <= 0) return undefined

    const createdMs = new Date(item.createdAt).getTime()
    if (!Number.isFinite(createdMs)) return undefined

    const ageMs = this.now().getTime() - createdMs
    if (ageMs < 0 || ageMs >= this.setupGraceMs) return undefined

    return this.setupGraceIntervalMs
  }

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
  private async refreshItemIfDue(item: StoredItemMeta, intervalMs?: number): Promise<void> {
    const effectiveInterval = intervalMs ?? this.setupGraceIntervalFor(item)
    if (!this.cache.shouldRefresh(item.itemId, { intervalMs: effectiveInterval })) return

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
