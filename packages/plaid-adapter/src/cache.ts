import { DatabaseSync } from 'node:sqlite'
import type { Account, Transaction } from '@clad/core'

/**
 * SQLite-backed cache for Plaid data, owning the `accounts_cache`,
 * `transactions_cache`, and `cursors` tables in the shared `plaid.sqlite`
 * database (see architecture decision #4 in the CRS-25 plan). The
 * `TokenStore` implementation (WP3) owns the `meta` and `items` tables in
 * the same file — this module never creates or touches those.
 *
 * Follows the `node:sqlite` `DatabaseSync` style used by
 * `packages/core/src/audit/logger.ts`.
 *
 * `accounts_cache.institution` (D3 QA amendment, 2026-07-10) persists
 * `Account.institution` so a degraded (`stale: true`) read still carries
 * which institution each account belongs to — see `PlaidAdapter`'s
 * `fetchAccountsForItem`/`getBalance`, which populate it from
 * `StoredItemMeta.institutionName`. A one-off `ALTER TABLE` in the
 * constructor migrates any `plaid.sqlite` created before this column
 * existed; see the comment there for why.
 */

/** A cached account row, including which Plaid item it belongs to. */
export interface CachedAccount extends Account {
  itemId: string
}

/** A cached transaction row, including which Plaid item it belongs to. */
export interface CachedTransaction extends Transaction {
  itemId: string
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
  updated_at: string
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
  updated_at: string
}

export class PlaidCache {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
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
        currency TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    // Migrates a `plaid.sqlite` created before the `institution` column
    // existed (added alongside PlaidAdapter populating `Account.institution`
    // from `StoredItemMeta.institutionName` — D3 QA amendment, 2026-07-10).
    // SQLite's ALTER TABLE has no `ADD COLUMN IF NOT EXISTS` form, so probe
    // by attempting the add and swallowing the "duplicate column" error a
    // database that already has the column — including one just created by
    // the CREATE TABLE above — throws.
    try {
      this.db.exec('ALTER TABLE accounts_cache ADD COLUMN institution TEXT')
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) {
        throw error
      }
    }
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
        pending INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transactions_cache_account_date
        ON transactions_cache (account_id, date)
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursors (
        item_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  // ---------------------------------------------------------------------
  // accounts_cache
  // ---------------------------------------------------------------------

  /** Inserts or replaces cached accounts for a single item. */
  upsertAccounts(itemId: string, accounts: Account[]): void {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO accounts_cache (
        account_id, item_id, name, type, subtype, institution, mask,
        balance_current, balance_available, currency, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        item_id = excluded.item_id,
        name = excluded.name,
        type = excluded.type,
        subtype = excluded.subtype,
        institution = excluded.institution,
        mask = excluded.mask,
        balance_current = excluded.balance_current,
        balance_available = excluded.balance_available,
        currency = excluded.currency,
        updated_at = excluded.updated_at
    `)
    for (const account of accounts) {
      stmt.run(
        account.id,
        itemId,
        account.name,
        account.type,
        account.subtype ?? null,
        account.institution ?? null,
        account.mask ?? null,
        account.balance_current,
        account.balance_available ?? null,
        account.currency,
        now
      )
    }
  }

  /** Returns all cached accounts across all items, sorted by account_id. */
  getAllAccounts(): CachedAccount[] {
    const stmt = this.db.prepare('SELECT * FROM accounts_cache ORDER BY account_id ASC')
    const rows = stmt.all() as unknown as AccountRow[]
    return rows.map(rowToAccount)
  }

  /** Returns all cached accounts belonging to a single item. */
  getAccountsByItem(itemId: string): CachedAccount[] {
    const stmt = this.db.prepare(
      'SELECT * FROM accounts_cache WHERE item_id = ? ORDER BY account_id ASC'
    )
    const rows = stmt.all(itemId) as unknown as AccountRow[]
    return rows.map(rowToAccount)
  }

  /** Looks up a single cached account by id, or undefined if not cached. */
  getAccount(accountId: string): CachedAccount | undefined {
    const stmt = this.db.prepare('SELECT * FROM accounts_cache WHERE account_id = ?')
    const row = stmt.get(accountId) as unknown as AccountRow | undefined
    return row ? rowToAccount(row) : undefined
  }

  /** Resolves which item owns a given account, or undefined if not cached. */
  getItemIdForAccount(accountId: string): string | undefined {
    return this.getAccount(accountId)?.itemId
  }

  // ---------------------------------------------------------------------
  // transactions_cache
  // ---------------------------------------------------------------------

  /** Inserts or replaces cached transactions (Plaid `added`/`modified`). */
  upsertTransactions(itemId: string, transactions: Transaction[]): void {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO transactions_cache (
        transaction_id, item_id, account_id, amount, date,
        description, merchant_name, category, pending, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET
        item_id = excluded.item_id,
        account_id = excluded.account_id,
        amount = excluded.amount,
        date = excluded.date,
        description = excluded.description,
        merchant_name = excluded.merchant_name,
        category = excluded.category,
        pending = excluded.pending,
        updated_at = excluded.updated_at
    `)
    for (const txn of transactions) {
      stmt.run(
        txn.id,
        itemId,
        txn.account_id,
        txn.amount,
        txn.date,
        txn.description,
        txn.merchant_name ?? null,
        txn.category ? JSON.stringify(txn.category) : null,
        txn.pending ? 1 : 0,
        now
      )
    }
  }

  /** Removes transactions by id (Plaid `removed`). */
  removeTransactions(transactionIds: string[]): void {
    if (transactionIds.length === 0) return
    const stmt = this.db.prepare('DELETE FROM transactions_cache WHERE transaction_id = ?')
    for (const id of transactionIds) {
      stmt.run(id)
    }
  }

  /**
   * Returns cached transactions for an account, filtered and sorted per
   * `TransactionQueryOpts` semantics (start/end date inclusive, count limit
   * applied after sorting, sorted by date descending).
   */
  getTransactionsByAccount(
    accountId: string,
    opts?: { start_date?: string; end_date?: string; count?: number }
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
    let transactions = rows.map(rowToTransaction)

    if (opts?.count !== undefined) {
      transactions = transactions.slice(0, opts.count)
    }

    return transactions
  }

  /** Returns all cached transactions belonging to a single item. */
  getTransactionsByItem(itemId: string): CachedTransaction[] {
    const stmt = this.db.prepare(
      'SELECT * FROM transactions_cache WHERE item_id = ? ORDER BY date DESC'
    )
    const rows = stmt.all(itemId) as unknown as TransactionRow[]
    return rows.map(rowToTransaction)
  }

  // ---------------------------------------------------------------------
  // cursors
  // ---------------------------------------------------------------------

  /** Returns the last saved `/transactions/sync` cursor for an item, if any. */
  getCursor(itemId: string): string | undefined {
    const stmt = this.db.prepare('SELECT cursor FROM cursors WHERE item_id = ?')
    const row = stmt.get(itemId) as unknown as { cursor: string } | undefined
    return row?.cursor
  }

  /** Persists the `/transactions/sync` cursor for an item. */
  saveCursor(itemId: string, cursor: string): void {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO cursors (item_id, cursor, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        cursor = excluded.cursor,
        updated_at = excluded.updated_at
    `)
    stmt.run(itemId, cursor, now)
  }

  // ---------------------------------------------------------------------
  // Removal
  // ---------------------------------------------------------------------

  /**
   * Purges every cached row this module owns for a single item — its cached
   * accounts, its cached transactions, and its `/transactions/sync` cursor.
   * Used when an item is disconnected (desktop "Remove connection"): the
   * `TokenStore` deletes the item's encrypted access token from `items`/`meta`
   * in the same file, and this drops the plaintext-but-non-secret cached data
   * that would otherwise linger forever with no token left to refresh it.
   * A no-op for an item that has nothing cached.
   */
  removeItem(itemId: string): void {
    this.db.prepare('DELETE FROM accounts_cache WHERE item_id = ?').run(itemId)
    this.db.prepare('DELETE FROM transactions_cache WHERE item_id = ?').run(itemId)
    this.db.prepare('DELETE FROM cursors WHERE item_id = ?').run(itemId)
  }

  close(): void {
    this.db.close()
  }
}

function rowToAccount(row: AccountRow): CachedAccount {
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
  }
}

function rowToTransaction(row: TransactionRow): CachedTransaction {
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
  }
}
