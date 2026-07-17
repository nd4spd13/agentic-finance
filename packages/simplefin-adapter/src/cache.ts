import { DatabaseSync } from 'node:sqlite'
import type { Account, Transaction, TransactionQueryOpts } from '@clad/core'

/**
 * SQLite-backed cache + quota guardrail for the SimpleFIN Bridge adapter
 * (SF4). Storage mechanism and read API shape follow
 * `packages/plaid-adapter/src/cache.ts` (`node:sqlite`'s `DatabaseSync`,
 * `accounts_cache`/`transactions_cache` tables, `itemId`-tagged rows,
 * `TransactionQueryOpts`-filtered reads) — but this module additionally owns
 * the **quota guardrail** the plan calls out as design-critical
 * (`packages/docs/plans/simplefin-adapter.md`, "Rate limits"): the Bridge
 * allows roughly 24 `/accounts` requests per day, so unlike Plaid (which
 * calls the API on every read and only degrades to the cache *reactively*,
 * on request failure — see `PlaidAdapter.getAccounts`), this cache must
 * *proactively* tell the adapter (`adapter.ts`, SF5) when a live fetch is
 * even allowed at all — see that file's `refreshItemIfDue`, which checks
 * {@link SimpleFinCache.shouldRefresh} before ever calling the network.
 *
 * Fail-closed design: {@link SimpleFinCache.shouldRefresh} returns `true`
 * only when a fetch is either the very first one ever for that item, or
 * the effective refresh interval has provably elapsed since the last
 * successful one. Every ambiguous case — a corrupt/unparseable stored
 * timestamp, or a clock that appears to have moved backwards
 * (`now() < lastFetchedAt`) — resolves to `false`: serve the cache with
 * staleness info rather than risk burning a request. "When in doubt, serve
 * stale" (plan security invariant #4).
 *
 * **`shouldRefresh` vs `getStaleness().stale` — two different questions.**
 * These used to be one function (`shouldRefresh` was literally
 * `getStaleness(itemId).stale`), which inverted the invariant above in
 * exactly the cases it names. `getStaleness` answers a *display* question
 * ("how fresh is what I'm showing?"), where an unknown age must report
 * `stale: true` to stay honest. `shouldRefresh` answers a *quota* question
 * ("may I spend one of ~24 daily requests?"), where an unknown age must
 * answer `false` or the guardrail is not a guardrail. Sharing one boolean
 * meant a backwards clock (an NTP correction is enough) made `shouldRefresh`
 * return `true` on *every* call — an ungated fetch per read, which the
 * developers guide says gets the access token disabled for sustained abuse.
 * They are computed separately now and must stay that way; `stale: true` and
 * "a fetch is allowed" are not the same claim.
 *
 * Ambiguity is *self-repairing* rather than permanent: a corrupt or
 * future-dated timestamp is rewritten to `now()` by {@link
 * SimpleFinCache.shouldRefresh} (see `repairFetchedAt`) so the item resumes
 * normal refreshes one interval later instead of freezing forever behind a
 * value it can never reason about. The repair deliberately does NOT touch
 * `fetch_history` — no request was spent, so nothing may be charged to the
 * budget.
 *
 * Quota budget: `fetch_log` holds one row per item (the last fetch, for the
 * interval gate), while `fetch_history` is append-only — one row per real
 * request — so {@link SimpleFinCache.requestsInLastDay} can count a rolling
 * 24h window against the Bridge's ~24/day soft cap. The interval gate alone
 * cannot do that: it only knows when *one* item last fetched, not how many
 * requests every item has spent together.
 *
 * Eviction semantics differ from Plaid's cache on purpose: SimpleFIN's
 * `/accounts` always returns each item's *complete* current account set
 * (there is no incremental `added`/`modified`/`removed` list the way
 * Plaid's `/transactions/sync` has), so {@link SimpleFinCache.recordFetch}
 * *replaces* — rather than merges into — an item's cached accounts and
 * transactions on every successful fetch. Anything cached for that item
 * that isn't present in the new snapshot (a closed account, a transaction
 * that no longer appears) no longer exists upstream and is deleted, not
 * left to linger forever.
 */

/** A cached account row, tagged with which SimpleFIN item it belongs to. */
export interface CachedAccount extends Account {
  itemId: string
}

/** A cached transaction row, tagged with which SimpleFIN item it belongs to. */
export interface CachedTransaction extends Transaction {
  itemId: string
}

/** Staleness/quota status for one item's cached snapshot. */
export interface StalenessInfo {
  /** ISO-8601 timestamp of the last successful live fetch, or `undefined` if this item has never been fetched. */
  lastFetchedAt: string | undefined
  /**
   * `true` when the cached snapshot should be treated as stale: no fetch
   * has ever succeeded for this item, at least `minRefreshIntervalMs` has
   * elapsed since the last one, or the stored timestamp/clock reading is
   * not sane (fail-closed default).
   */
  stale: boolean
  /** Milliseconds elapsed since the last successful fetch, or `undefined` if never fetched. */
  ageMs: number | undefined
}

export interface SimpleFinCacheOptions {
  /** Path to the SQLite database file (or `:memory:`). */
  dbPath: string
  /**
   * Minimum time that must elapse between live `/accounts` fetches for the
   * same item before {@link SimpleFinCache.shouldRefresh} allows another
   * one. Defaults to 6 hours, matching the plan's design ("persist
   * last-fetch timestamp + response per item; enforce a minimum refresh
   * interval (default: 6h, configurable)").
   */
  minRefreshIntervalMs?: number
  /**
   * Injectable clock, defaulting to `() => new Date()`. Tests can either
   * pass a fake clock here or use `vi.useFakeTimers()` (which also drives
   * the default `new Date()`), matching `plaid-adapter`'s general test
   * style while giving this time-sensitive cache an explicit seam.
   */
  now?: () => Date
}

const DEFAULT_MIN_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

/** Rolling window `requestsInLastDay` counts over — the Bridge's cap is expressed per day. */
const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * How long `fetch_history` rows are kept. Longer than {@link
 * BUDGET_WINDOW_MS} so a row is never pruned while it still counts against
 * the rolling window, with room left to inspect recent history when
 * diagnosing quota questions.
 */
const HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000

interface FetchLogRow {
  fetched_at: string
}

interface CountRow {
  count: number
}

interface AccountRow {
  account_id: string
  item_id: string
  name: string
  type: string
  subtype: string | null
  institution: string | null
  mask: string | null
  balance_current: number
  balance_available: number | null
  currency: string
}

interface TransactionRow {
  transaction_id: string
  item_id: string
  account_id: string
  amount: number
  date: string
  description: string
  merchant_name: string | null
  category: string | null
  pending: number
}

export class SimpleFinCache {
  private readonly db: DatabaseSync
  private readonly minRefreshIntervalMs: number
  private readonly now: () => Date

  constructor(options: SimpleFinCacheOptions) {
    this.db = new DatabaseSync(options.dbPath)
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS
    this.now = options.now ?? (() => new Date())

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fetch_log (
        item_id TEXT PRIMARY KEY,
        fetched_at TEXT NOT NULL
      )
    `)
    // Append-only sibling of fetch_log: one row per real request, across all
    // items, so requestsInLastDay() can count a rolling 24h window against
    // the Bridge's ~24/day cap. Purely additive — fetch_log keeps its
    // existing one-row-per-item meaning, so an existing DB (a live desktop
    // install's simplefin.sqlite) needs no migration and loses nothing; the
    // budget simply starts counting from the first fetch after this upgrade.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fetch_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fetch_history_fetched_at
        ON fetch_history (fetched_at)
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts_cache (
        account_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        subtype TEXT,
        institution TEXT,
        mask TEXT,
        balance_current REAL NOT NULL,
        balance_available REAL,
        currency TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_accounts_cache_item
        ON accounts_cache (item_id)
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions_cache (
        transaction_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        amount REAL NOT NULL,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        merchant_name TEXT,
        category TEXT,
        pending INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transactions_cache_item
        ON transactions_cache (item_id)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transactions_cache_account_date
        ON transactions_cache (account_id, date)
    `)
  }

  // ---------------------------------------------------------------------
  // Quota guardrail
  // ---------------------------------------------------------------------

  /**
   * Fail-closed quota gate — "may I spend one of ~24 daily requests?".
   * Deliberately NOT `getStaleness(itemId).stale`; see the module doc for
   * why those two answers must not share a boolean.
   *
   * Returns `true` only if this item has never been fetched before (there is
   * nothing to serve from cache yet, so a first fetch is unavoidable) or the
   * effective interval has *provably* elapsed since the last successful
   * fetch. Returns `false` in every other case, including when the stored
   * timestamp is unparseable or sits in the future relative to `now()` — an
   * age we cannot compute is never grounds for spending a request.
   *
   * `opts.intervalMs` overrides `minRefreshIntervalMs` for this call only,
   * which is how `adapter.ts` applies its post-setup grace window without
   * this cache needing to know what a "setup window" is. It cannot be used
   * to bypass the gate outright: a caller passing `0` still gets the
   * fail-closed answer for an unreadable timestamp.
   */
  shouldRefresh(itemId: string, opts?: { intervalMs?: number }): boolean {
    const intervalMs = opts?.intervalMs ?? this.minRefreshIntervalMs
    const lastFetchedAt = this.getFetchedAt(itemId)
    if (lastFetchedAt === undefined) return true

    const ageMs = this.ageMsOrRepair(itemId, lastFetchedAt)
    if (ageMs === undefined) return false

    return ageMs >= intervalMs
  }

  /**
   * Milliseconds until {@link shouldRefresh} would next return `true`, or
   * `0` if it already would. Mirrors `shouldRefresh`'s gate exactly (same
   * `opts.intervalMs`, same fail-closed repair) so the countdown a caller
   * shows can never disagree with the decision the gate actually makes —
   * `msUntilRefreshAllowed(...) === 0` iff `shouldRefresh(...)` is `true`.
   */
  msUntilRefreshAllowed(itemId: string, opts?: { intervalMs?: number }): number {
    const intervalMs = opts?.intervalMs ?? this.minRefreshIntervalMs
    const lastFetchedAt = this.getFetchedAt(itemId)
    if (lastFetchedAt === undefined) return 0

    const ageMs = this.ageMsOrRepair(itemId, lastFetchedAt)
    // Repaired just now: the full interval is what remains.
    if (ageMs === undefined) return intervalMs

    const remaining = intervalMs - ageMs
    return remaining > 0 ? remaining : 0
  }

  /**
   * Number of real requests recorded in the last {@link BUDGET_WINDOW_MS},
   * across every item — what a caller checks against the Bridge's ~24/day
   * soft cap before allowing a user-initiated force refresh to skip the
   * interval gate.
   *
   * Counts `fetch_history` (append-only, one row per request), never
   * `fetch_log` (one row per item, overwritten each fetch — it cannot
   * answer "how many requests today?" at all). Only rows written by
   * {@link recordFetch} count: a timestamp repair spends no request and is
   * never charged here.
   */
  requestsInLastDay(): number {
    const since = new Date(this.now().getTime() - BUDGET_WINDOW_MS).toISOString()
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM fetch_history WHERE fetched_at >= ?')
      .get(since) as unknown as CountRow | undefined
    return row?.count ?? 0
  }

  /**
   * Age of a last-fetch timestamp, or `undefined` when it cannot be trusted
   * — in which case the row is repaired to `now()` so the item resumes
   * normal refreshes one interval from now rather than freezing behind a
   * value no amount of waiting can fix (a corrupt string never becomes
   * parseable; a future timestamp from a since-corrected clock could sit
   * ahead of `now()` for years).
   *
   * The repair writes `fetch_log` ONLY. Charging `fetch_history` here would
   * bill the user's daily budget for a request that was never sent.
   */
  private ageMsOrRepair(itemId: string, lastFetchedAt: string): number | undefined {
    const lastFetchedMs = new Date(lastFetchedAt).getTime()
    if (!Number.isFinite(lastFetchedMs)) {
      this.repairFetchedAt(itemId)
      return undefined
    }

    const ageMs = this.now().getTime() - lastFetchedMs
    if (ageMs < 0) {
      this.repairFetchedAt(itemId)
      return undefined
    }

    return ageMs
  }

  /** Rewrites an untrustworthy `fetch_log.fetched_at` to `now()`. See {@link ageMsOrRepair}. */
  private repairFetchedAt(itemId: string): void {
    this.db
      .prepare('UPDATE fetch_log SET fetched_at = ? WHERE item_id = ?')
      .run(this.now().toISOString(), itemId)
  }

  /**
   * Returns the last-fetch time and staleness status for an item, without
   * its cached accounts/transactions payload (see {@link getAccounts} /
   * {@link getTransactionsByItem} for that).
   */
  getStaleness(itemId: string): StalenessInfo {
    const lastFetchedAt = this.getFetchedAt(itemId)
    if (lastFetchedAt === undefined) {
      return { lastFetchedAt: undefined, stale: true, ageMs: undefined }
    }

    const lastFetchedMs = new Date(lastFetchedAt).getTime()
    if (!Number.isFinite(lastFetchedMs)) {
      // Corrupt/unparseable timestamp: fail closed rather than guess.
      return { lastFetchedAt, stale: true, ageMs: undefined }
    }

    const ageMs = this.now().getTime() - lastFetchedMs
    // Negative age means the clock moved backwards relative to the stored
    // timestamp; treat that as stale (fail closed) rather than "fresh".
    const stale = ageMs < 0 || ageMs >= this.minRefreshIntervalMs
    return { lastFetchedAt, stale, ageMs }
  }

  /**
   * Records a successful live fetch for `itemId`: stamps `fetched_at =
   * now()` (both the `fetch_log` interval gate and the `fetch_history`
   * budget ledger) and *replaces* (see module docs on eviction semantics)
   * that item's cached accounts and transactions with the given snapshot.
   *
   * This is the ONLY method that appends to `fetch_history` — it is called
   * once per real request, so the rolling count stays an accurate ledger of
   * quota actually spent.
   */
  recordFetch(itemId: string, accounts: Account[], transactions: Transaction[]): void {
    const fetchedAt = this.now().toISOString()

    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          `INSERT INTO fetch_log (item_id, fetched_at) VALUES (?, ?)
           ON CONFLICT(item_id) DO UPDATE SET fetched_at = excluded.fetched_at`
        )
        .run(itemId, fetchedAt)

      this.db
        .prepare('INSERT INTO fetch_history (item_id, fetched_at) VALUES (?, ?)')
        .run(itemId, fetchedAt)

      // Prune inside the same transaction: the ledger stays bounded without
      // needing a separate sweep, and a rollback below leaves both the new
      // row and the prune undone together.
      this.db
        .prepare('DELETE FROM fetch_history WHERE fetched_at < ?')
        .run(new Date(this.now().getTime() - HISTORY_RETENTION_MS).toISOString())

      this.db.prepare('DELETE FROM accounts_cache WHERE item_id = ?').run(itemId)
      this.db.prepare('DELETE FROM transactions_cache WHERE item_id = ?').run(itemId)

      const insertAccount = this.db.prepare(`
        INSERT INTO accounts_cache (
          account_id, item_id, name, type, subtype, institution, mask,
          balance_current, balance_available, currency
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const account of accounts) {
        insertAccount.run(
          account.id,
          itemId,
          account.name,
          account.type,
          account.subtype ?? null,
          account.institution ?? null,
          account.mask ?? null,
          account.balance_current,
          account.balance_available ?? null,
          account.currency
        )
      }

      const insertTransaction = this.db.prepare(`
        INSERT INTO transactions_cache (
          transaction_id, item_id, account_id, amount, date,
          description, merchant_name, category, pending
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const txn of transactions) {
        insertTransaction.run(
          txn.id,
          itemId,
          txn.account_id,
          txn.amount,
          txn.date,
          txn.description,
          txn.merchant_name ?? null,
          txn.category ? JSON.stringify(txn.category) : null,
          txn.pending ? 1 : 0
        )
      }

      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /** All cached accounts for one item, marked `stale` per {@link getStaleness}. */
  getAccounts(itemId: string): CachedAccount[] {
    const stale = this.getStaleness(itemId).stale
    const stmt = this.db.prepare(
      'SELECT * FROM accounts_cache WHERE item_id = ? ORDER BY account_id ASC'
    )
    const rows = stmt.all(itemId) as unknown as AccountRow[]
    return rows.map((row) => rowToAccount(row, stale))
  }

  /** All cached accounts across every item, each marked `stale` per its own item's staleness. */
  getAllAccounts(): CachedAccount[] {
    const stmt = this.db.prepare('SELECT * FROM accounts_cache ORDER BY account_id ASC')
    const rows = stmt.all() as unknown as AccountRow[]
    return rows.map((row) => rowToAccount(row, this.getStaleness(row.item_id).stale))
  }

  /** Looks up a single cached account by its (already-namespaced) id. */
  getAccount(accountId: string): CachedAccount | undefined {
    const stmt = this.db.prepare('SELECT * FROM accounts_cache WHERE account_id = ?')
    const row = stmt.get(accountId) as unknown as AccountRow | undefined
    if (!row) return undefined
    return rowToAccount(row, this.getStaleness(row.item_id).stale)
  }

  /**
   * Cached transactions for an account, filtered/sorted per
   * `TransactionQueryOpts` (start/end date inclusive, count limit applied
   * after sorting, sorted by date descending) — matches
   * `plaid-adapter/src/cache.ts`'s `getTransactionsByAccount` semantics.
   */
  getTransactionsByAccount(
    accountId: string,
    opts?: TransactionQueryOpts
  ): CachedTransaction[] {
    let query = 'SELECT * FROM transactions_cache WHERE account_id = ?'
    const params: (string | number)[] = [accountId]

    if (opts?.start_date) {
      query += ' AND date >= ?'
      params.push(opts.start_date)
    }
    if (opts?.end_date) {
      query += ' AND date <= ?'
      params.push(opts.end_date)
    }

    query += ' ORDER BY date DESC'

    const stmt = this.db.prepare(query)
    const rows = stmt.all(...params) as unknown as TransactionRow[]
    let transactions = rows.map((row) => rowToTransaction(row, this.getStaleness(row.item_id).stale))

    if (opts?.count !== undefined) {
      transactions = transactions.slice(0, opts.count)
    }

    return transactions
  }

  /** All cached transactions for a single item, sorted by date descending. */
  getTransactionsByItem(itemId: string): CachedTransaction[] {
    const stale = this.getStaleness(itemId).stale
    const stmt = this.db.prepare(
      'SELECT * FROM transactions_cache WHERE item_id = ? ORDER BY date DESC'
    )
    const rows = stmt.all(itemId) as unknown as TransactionRow[]
    return rows.map((row) => rowToTransaction(row, stale))
  }

  // ---------------------------------------------------------------------
  // Removal
  // ---------------------------------------------------------------------

  /**
   * Purges the rows this cache owns for a single item — its cached accounts,
   * its cached transactions, and its `fetch_log` quota-timestamp entry. Used
   * when a SimpleFIN item is disconnected (desktop "Remove connection"): the
   * `TokenStore` deletes the item's encrypted access URL from `items`/`meta`
   * in the same file, and this drops the non-secret cached data (and the
   * fetch-log row, so a later item that happened to reuse the same id would
   * start fresh rather than inherit a stale last-fetch time). Wrapped in a
   * transaction for the same all-or-nothing reason `recordFetch` is. A no-op
   * for an item that has nothing cached.
   *
   * `fetch_history` is deliberately left ALONE — the one thing this does not
   * purge. Those requests were really spent against the Bridge today, and
   * forgetting them would make remove-then-re-add a way to zero the daily
   * budget and walk straight into the cap this cache exists to respect.
   * The rows carry no financial data (an item id and a timestamp) and age
   * out on their own via `recordFetch`'s prune.
   */
  removeItem(itemId: string): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM fetch_log WHERE item_id = ?').run(itemId)
      this.db.prepare('DELETE FROM accounts_cache WHERE item_id = ?').run(itemId)
      this.db.prepare('DELETE FROM transactions_cache WHERE item_id = ?').run(itemId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private getFetchedAt(itemId: string): string | undefined {
    const row = this.db
      .prepare('SELECT fetched_at FROM fetch_log WHERE item_id = ?')
      .get(itemId) as unknown as FetchLogRow | undefined
    return row?.fetched_at
  }
}

function rowToAccount(row: AccountRow, stale: boolean): CachedAccount {
  return {
    id: row.account_id,
    itemId: row.item_id,
    name: row.name,
    type: row.type as Account['type'],
    subtype: row.subtype ?? undefined,
    institution: row.institution ?? undefined,
    mask: row.mask ?? undefined,
    balance_current: row.balance_current,
    balance_available: row.balance_available ?? undefined,
    currency: row.currency,
    ...(stale ? { stale: true } : {}),
  }
}

function rowToTransaction(row: TransactionRow, stale: boolean): CachedTransaction {
  return {
    id: row.transaction_id,
    itemId: row.item_id,
    account_id: row.account_id,
    amount: row.amount,
    date: row.date,
    description: row.description,
    merchant_name: row.merchant_name ?? undefined,
    category: row.category ? (JSON.parse(row.category) as string[]) : undefined,
    pending: row.pending === 1,
    ...(stale ? { stale: true } : {}),
  }
}
