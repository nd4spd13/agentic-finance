import { DatabaseSync } from 'node:sqlite'
import {
  encrypt,
  decrypt,
  enforceFileMode,
  openDatabaseKey,
  type Account,
  type EncryptedPayload,
  type Transaction,
} from '@clad/core'

/**
 * SQLite-backed cache for Plaid data, owning the `accounts_cache`,
 * `transactions_cache`, and `cursors` tables in the shared `plaid.sqlite`
 * database (see architecture decision #4 in the CRS-25 plan). The
 * `TokenStore` implementation (WP3) owns the `meta` and `items` tables in
 * the same file — this module never creates or touches those.
 *
 * Encrypted at rest (D5.1): every column that could carry financial data —
 * account names/types/balances, transaction amounts/dates/descriptions, and
 * the `/transactions/sync` cursor — is stored as an AES-256-GCM
 * `ciphertext`/`iv`/`auth_tag` triple under the same key the shared
 * `SqliteTokenStore` uses (one salt, one derived key, one passphrase per
 * file — see `openDatabaseKey`). Only routing identifiers that the cache must
 * query by (`account_id`, `item_id`, `transaction_id`) and non-sensitive
 * bookkeeping (`updated_at`) remain plaintext. The key is derived once in the
 * constructor via `openDatabaseKey`, which also enforces the shared
 * passphrase (throwing `TokenStoreKeyError` on a mismatch).
 *
 * Migration from the pre-D5.1 plaintext schema is a drop-and-recreate plus
 * `VACUUM` (see the constructor): the cache is fully re-fetchable (Plaid
 * full-resyncs from a null cursor), so the safest scrub of the old plaintext
 * rows — including SQLite's free pages — is to discard them and let the next
 * sync repopulate encrypted rows.
 */

/** A cached account row, including which Plaid item it belongs to. */
export interface CachedAccount extends Account {
  itemId: string
}

/** A cached transaction row, including which Plaid item it belongs to. */
export interface CachedTransaction extends Transaction {
  itemId: string
}

export interface PlaidCacheOptions {
  /** Path to the SQLite database file (or `:memory:`). Shared with `SqliteTokenStore`. */
  dbPath: string
  /** Passphrase that unlocks the shared AES-256 key (same one the token store uses). */
  passphrase: string
}

/** The plaintext-JSON shape sealed into `accounts_cache`'s encrypted blob. */
interface AccountBlob {
  name: string
  type: string
  subtype: string | null
  institution: string | null
  mask: string | null
  balance_current: number
  balance_available: number | null
  currency: string
}

/** The plaintext-JSON shape sealed into `transactions_cache`'s encrypted blob. */
interface TransactionBlob {
  amount: number
  date: string
  description: string
  merchant_name: string | null
  category: string[] | null
  pending: boolean
}

interface AccountRow {
  account_id: string
  item_id: string
  ciphertext: Buffer
  iv: Buffer
  auth_tag: Buffer
  updated_at: string
}

interface TransactionRow {
  transaction_id: string
  item_id: string
  account_id: string
  ciphertext: Buffer
  iv: Buffer
  auth_tag: Buffer
  updated_at: string
}

interface CursorRow {
  ciphertext: Buffer
  iv: Buffer
  auth_tag: Buffer
}

export class PlaidCache {
  private readonly db: DatabaseSync
  private readonly key: Buffer

  constructor(options: PlaidCacheOptions) {
    const { dbPath, passphrase } = options
    this.db = new DatabaseSync(dbPath)

    // Migrate a pre-D5.1 plaintext cache before creating any new-format table,
    // so the detection below can't be fooled by a table this constructor just
    // created. Plaid data is fully re-fetchable (a null cursor triggers a
    // complete resync), so the safe scrub is drop-and-recreate + VACUUM.
    this.migrateFromPlaintext()

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts_cache (
        account_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions_cache (
        transaction_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transactions_cache_account
        ON transactions_cache (account_id)
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursors (
        item_id TEXT PRIMARY KEY,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)

    // Restrict the shared file to owner-only, derive/verify the AES-256 key,
    // then re-apply the mode in case the first write only just created the file.
    enforceFileMode(dbPath)
    this.key = openDatabaseKey(this.db, passphrase)
    enforceFileMode(dbPath)
  }

  /**
   * Detects the pre-D5.1 plaintext schema (an `accounts_cache` with a `name`
   * column but no `ciphertext` column) and, if found, drops the cache tables
   * so the new-format `CREATE TABLE`s recreate them empty, then `VACUUM`s to
   * scrub the old plaintext from SQLite's free pages. A no-op on a fresh DB
   * (no `accounts_cache` yet) or one already in the new format.
   */
  private migrateFromPlaintext(): void {
    const columns = this.db.prepare('PRAGMA table_info(accounts_cache)').all() as Array<{
      name: string
    }>
    if (columns.length === 0) return // no accounts_cache yet — fresh DB
    const hasCiphertext = columns.some((c) => c.name === 'ciphertext')
    const hasPlaintext = columns.some((c) => c.name === 'name')
    if (hasCiphertext || !hasPlaintext) return // already new format

    this.db.exec('DROP TABLE IF EXISTS accounts_cache')
    this.db.exec('DROP TABLE IF EXISTS transactions_cache')
    this.db.exec('DROP TABLE IF EXISTS cursors')
    // Rewrites the file, scrubbing the dropped tables' plaintext from free pages.
    this.db.exec('VACUUM')
  }

  private encryptJson(obj: unknown): EncryptedPayload {
    return encrypt(this.key, JSON.stringify(obj))
  }

  private decryptAccount(row: AccountRow): AccountBlob {
    return JSON.parse(decrypt(this.key, toPayload(row))) as AccountBlob
  }

  private decryptTransaction(row: TransactionRow): TransactionBlob {
    return JSON.parse(decrypt(this.key, toPayload(row))) as TransactionBlob
  }

  // ---------------------------------------------------------------------
  // accounts_cache
  // ---------------------------------------------------------------------

  /** Inserts or replaces cached accounts for a single item. */
  upsertAccounts(itemId: string, accounts: Account[]): void {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO accounts_cache (
        account_id, item_id, ciphertext, iv, auth_tag, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        item_id = excluded.item_id,
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `)
    for (const account of accounts) {
      const blob: AccountBlob = {
        name: account.name,
        type: account.type,
        subtype: account.subtype ?? null,
        institution: account.institution ?? null,
        mask: account.mask ?? null,
        balance_current: account.balance_current,
        balance_available: account.balance_available ?? null,
        currency: account.currency,
      }
      const payload = this.encryptJson(blob)
      stmt.run(account.id, itemId, payload.ciphertext, payload.iv, payload.authTag, now)
    }
  }

  /** Returns all cached accounts across all items, sorted by account_id. */
  getAllAccounts(): CachedAccount[] {
    const stmt = this.db.prepare('SELECT * FROM accounts_cache ORDER BY account_id ASC')
    const rows = stmt.all() as unknown as AccountRow[]
    return rows.map((row) => this.rowToAccount(row))
  }

  /** Returns all cached accounts belonging to a single item. */
  getAccountsByItem(itemId: string): CachedAccount[] {
    const stmt = this.db.prepare(
      'SELECT * FROM accounts_cache WHERE item_id = ? ORDER BY account_id ASC'
    )
    const rows = stmt.all(itemId) as unknown as AccountRow[]
    return rows.map((row) => this.rowToAccount(row))
  }

  /** Looks up a single cached account by id, or undefined if not cached. */
  getAccount(accountId: string): CachedAccount | undefined {
    const stmt = this.db.prepare('SELECT * FROM accounts_cache WHERE account_id = ?')
    const row = stmt.get(accountId) as unknown as AccountRow | undefined
    return row ? this.rowToAccount(row) : undefined
  }

  /** Resolves which item owns a given account, or undefined if not cached. */
  getItemIdForAccount(accountId: string): string | undefined {
    const stmt = this.db.prepare('SELECT item_id FROM accounts_cache WHERE account_id = ?')
    const row = stmt.get(accountId) as unknown as { item_id: string } | undefined
    return row?.item_id
  }

  // ---------------------------------------------------------------------
  // transactions_cache
  // ---------------------------------------------------------------------

  /** Inserts or replaces cached transactions (Plaid `added`/`modified`). */
  upsertTransactions(itemId: string, transactions: Transaction[]): void {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO transactions_cache (
        transaction_id, item_id, account_id, ciphertext, iv, auth_tag, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET
        item_id = excluded.item_id,
        account_id = excluded.account_id,
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `)
    for (const txn of transactions) {
      const blob: TransactionBlob = {
        amount: txn.amount,
        date: txn.date,
        description: txn.description,
        merchant_name: txn.merchant_name ?? null,
        category: txn.category ?? null,
        pending: txn.pending ?? false,
      }
      const payload = this.encryptJson(blob)
      stmt.run(
        txn.id,
        itemId,
        txn.account_id,
        payload.ciphertext,
        payload.iv,
        payload.authTag,
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
   * applied after sorting, sorted by date descending). Since `date` now lives
   * inside the encrypted blob, filtering/sorting/limiting all happen in memory
   * after decrypt — only `account_id` (plaintext) is filtered in SQL.
   */
  getTransactionsByAccount(
    accountId: string,
    opts?: { start_date?: string; end_date?: string; count?: number }
  ): CachedTransaction[] {
    const stmt = this.db.prepare('SELECT * FROM transactions_cache WHERE account_id = ?')
    const rows = stmt.all(accountId) as unknown as TransactionRow[]
    let transactions = rows.map((row) => this.rowToTransaction(row))

    if (opts?.start_date) {
      transactions = transactions.filter((t) => t.date >= opts.start_date!)
    }
    if (opts?.end_date) {
      transactions = transactions.filter((t) => t.date <= opts.end_date!)
    }

    transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

    if (opts?.count !== undefined) {
      transactions = transactions.slice(0, opts.count)
    }

    return transactions
  }

  /** Returns all cached transactions belonging to a single item, date descending. */
  getTransactionsByItem(itemId: string): CachedTransaction[] {
    const stmt = this.db.prepare('SELECT * FROM transactions_cache WHERE item_id = ?')
    const rows = stmt.all(itemId) as unknown as TransactionRow[]
    const transactions = rows.map((row) => this.rowToTransaction(row))
    transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    return transactions
  }

  // ---------------------------------------------------------------------
  // cursors
  // ---------------------------------------------------------------------

  /** Returns the last saved `/transactions/sync` cursor for an item, if any. */
  getCursor(itemId: string): string | undefined {
    const stmt = this.db.prepare(
      'SELECT ciphertext, iv, auth_tag FROM cursors WHERE item_id = ?'
    )
    const row = stmt.get(itemId) as unknown as CursorRow | undefined
    if (!row) return undefined
    return decrypt(this.key, toPayload(row))
  }

  /** Persists the `/transactions/sync` cursor for an item. */
  saveCursor(itemId: string, cursor: string): void {
    const now = new Date().toISOString()
    const payload = encrypt(this.key, cursor)
    const stmt = this.db.prepare(`
      INSERT INTO cursors (item_id, ciphertext, iv, auth_tag, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `)
    stmt.run(itemId, payload.ciphertext, payload.iv, payload.authTag, now)
  }

  // ---------------------------------------------------------------------
  // Removal
  // ---------------------------------------------------------------------

  /**
   * Purges every cached row this module owns for a single item — its cached
   * accounts, its cached transactions, and its `/transactions/sync` cursor.
   * Used when an item is disconnected (desktop "Remove connection"): the
   * `TokenStore` deletes the item's encrypted access token from `items`/`meta`
   * in the same file, and this drops the cached data that would otherwise
   * linger forever with no token left to refresh it. A no-op for an item that
   * has nothing cached.
   */
  removeItem(itemId: string): void {
    this.db.prepare('DELETE FROM accounts_cache WHERE item_id = ?').run(itemId)
    this.db.prepare('DELETE FROM transactions_cache WHERE item_id = ?').run(itemId)
    this.db.prepare('DELETE FROM cursors WHERE item_id = ?').run(itemId)
  }

  close(): void {
    this.db.close()
  }

  private rowToAccount(row: AccountRow): CachedAccount {
    const blob = this.decryptAccount(row)
    return {
      id: row.account_id,
      itemId: row.item_id,
      name: blob.name,
      type: blob.type as Account['type'],
      subtype: blob.subtype ?? undefined,
      institution: blob.institution ?? undefined,
      mask: blob.mask ?? undefined,
      balance_current: blob.balance_current,
      balance_available: blob.balance_available ?? undefined,
      currency: blob.currency,
    }
  }

  private rowToTransaction(row: TransactionRow): CachedTransaction {
    const blob = this.decryptTransaction(row)
    return {
      id: row.transaction_id,
      itemId: row.item_id,
      account_id: row.account_id,
      amount: blob.amount,
      date: blob.date,
      description: blob.description,
      merchant_name: blob.merchant_name ?? undefined,
      category: blob.category ?? undefined,
      pending: blob.pending,
    }
  }
}

function toPayload(row: {
  ciphertext: Buffer
  iv: Buffer
  auth_tag: Buffer
}): EncryptedPayload {
  return {
    ciphertext: Buffer.from(row.ciphertext),
    iv: Buffer.from(row.iv),
    authTag: Buffer.from(row.auth_tag),
  }
}
