import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TokenStoreKeyError, type Account, type Transaction } from '@clad/core'
import { PlaidCache } from '../src/cache.js'

const TEST_PASSPHRASE = 'correct horse battery staple'

describe('PlaidCache', () => {
  let dir: string
  let dbPath: string
  let cache: PlaidCache

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plaid-cache-test-'))
    dbPath = join(dir, 'plaid.sqlite')
    cache = new PlaidCache({ dbPath, passphrase: TEST_PASSPHRASE })
  })

  afterEach(() => {
    try {
      cache.close()
    } catch {
      // already closed by the test itself (e.g. reopen tests)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const account: Account = {
    id: 'acc_1',
    name: 'Checking',
    type: 'checking',
    mask: '1234',
    balance_current: 100,
    balance_available: 90,
    currency: 'USD',
  }

  const transaction: Transaction = {
    id: 'txn_1',
    account_id: 'acc_1',
    amount: -20,
    date: '2026-01-05',
    description: 'Coffee',
    merchant_name: 'Cafe',
    category: ['food_and_drink', 'coffee'],
    pending: false,
  }

  describe('accounts_cache', () => {
    it('upserts and reads back an account, tagged with its item', () => {
      cache.upsertAccounts('item_1', [account])
      const all = cache.getAllAccounts()
      expect(all).toHaveLength(1)
      expect(all[0]).toMatchObject({ ...account, itemId: 'item_1' })
    })

    it('updates an existing account on conflict rather than duplicating', () => {
      cache.upsertAccounts('item_1', [account])
      cache.upsertAccounts('item_1', [{ ...account, balance_current: 200 }])
      const all = cache.getAllAccounts()
      expect(all).toHaveLength(1)
      expect(all[0].balance_current).toBe(200)
    })

    it('scopes getAccountsByItem to the requested item', () => {
      cache.upsertAccounts('item_1', [account])
      cache.upsertAccounts('item_2', [{ ...account, id: 'acc_2' }])
      expect(cache.getAccountsByItem('item_1').map(a => a.id)).toEqual(['acc_1'])
      expect(cache.getAccountsByItem('item_2').map(a => a.id)).toEqual(['acc_2'])
    })

    it('getAccount returns undefined for an uncached account', () => {
      expect(cache.getAccount('nope')).toBeUndefined()
    })

    it('getItemIdForAccount resolves the owning item', () => {
      cache.upsertAccounts('item_1', [account])
      expect(cache.getItemIdForAccount('acc_1')).toBe('item_1')
      expect(cache.getItemIdForAccount('missing')).toBeUndefined()
    })

    it('preserves undefined optional fields as undefined on read-back', () => {
      cache.upsertAccounts('item_1', [{ ...account, subtype: undefined, mask: undefined, balance_available: undefined }])
      const [cached] = cache.getAllAccounts()
      expect(cached.subtype).toBeUndefined()
      expect(cached.mask).toBeUndefined()
      expect(cached.balance_available).toBeUndefined()
    })

    it('persists and reads back institution', () => {
      cache.upsertAccounts('item_1', [{ ...account, institution: 'Fake Bank' }])
      const [cached] = cache.getAllAccounts()
      expect(cached.institution).toBe('Fake Bank')
    })

    it('leaves institution undefined when not provided', () => {
      cache.upsertAccounts('item_1', [account])
      const [cached] = cache.getAllAccounts()
      expect(cached.institution).toBeUndefined()
    })

    it('updates institution on conflict rather than keeping the old value', () => {
      cache.upsertAccounts('item_1', [{ ...account, institution: 'Old Bank' }])
      cache.upsertAccounts('item_1', [{ ...account, institution: 'New Bank' }])
      const [cached] = cache.getAllAccounts()
      expect(cached.institution).toBe('New Bank')
    })

  })

  describe('transactions_cache', () => {
    it('upserts and reads back a transaction by account', () => {
      cache.upsertTransactions('item_1', [transaction])
      const rows = cache.getTransactionsByAccount('acc_1')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ ...transaction, itemId: 'item_1' })
    })

    it('updates an existing transaction on conflict (modified)', () => {
      cache.upsertTransactions('item_1', [transaction])
      cache.upsertTransactions('item_1', [{ ...transaction, amount: -99, pending: true }])
      const rows = cache.getTransactionsByAccount('acc_1')
      expect(rows).toHaveLength(1)
      expect(rows[0].amount).toBe(-99)
      expect(rows[0].pending).toBe(true)
    })

    it('removes transactions by id', () => {
      cache.upsertTransactions('item_1', [transaction])
      cache.removeTransactions(['txn_1'])
      expect(cache.getTransactionsByAccount('acc_1')).toHaveLength(0)
    })

    it('removeTransactions is a no-op for unknown ids', () => {
      cache.upsertTransactions('item_1', [transaction])
      cache.removeTransactions(['does_not_exist'])
      expect(cache.getTransactionsByAccount('acc_1')).toHaveLength(1)
    })

    it('removeTransactions handles an empty array', () => {
      cache.upsertTransactions('item_1', [transaction])
      cache.removeTransactions([])
      expect(cache.getTransactionsByAccount('acc_1')).toHaveLength(1)
    })

    it('sorts results by date descending', () => {
      cache.upsertTransactions('item_1', [
        { ...transaction, id: 'txn_a', date: '2026-01-01' },
        { ...transaction, id: 'txn_b', date: '2026-03-01' },
        { ...transaction, id: 'txn_c', date: '2026-02-01' },
      ])
      const rows = cache.getTransactionsByAccount('acc_1')
      expect(rows.map(r => r.id)).toEqual(['txn_b', 'txn_c', 'txn_a'])
    })

    it('applies inclusive start_date and end_date filters', () => {
      cache.upsertTransactions('item_1', [
        { ...transaction, id: 'txn_a', date: '2026-01-01' },
        { ...transaction, id: 'txn_b', date: '2026-02-01' },
        { ...transaction, id: 'txn_c', date: '2026-03-01' },
      ])
      const rows = cache.getTransactionsByAccount('acc_1', {
        start_date: '2026-01-01',
        end_date: '2026-02-01',
      })
      expect(rows.map(r => r.id).sort()).toEqual(['txn_a', 'txn_b'])
    })

    it('applies the count limit after sorting by date descending', () => {
      cache.upsertTransactions('item_1', [
        { ...transaction, id: 'txn_a', date: '2026-01-01' },
        { ...transaction, id: 'txn_b', date: '2026-03-01' },
        { ...transaction, id: 'txn_c', date: '2026-02-01' },
      ])
      const rows = cache.getTransactionsByAccount('acc_1', { count: 2 })
      expect(rows.map(r => r.id)).toEqual(['txn_b', 'txn_c'])
    })

    it('does not mix transactions from other accounts', () => {
      cache.upsertTransactions('item_1', [transaction, { ...transaction, id: 'txn_2', account_id: 'acc_2' }])
      expect(cache.getTransactionsByAccount('acc_1').map(r => r.id)).toEqual(['txn_1'])
    })

    it('serializes and deserializes category arrays', () => {
      cache.upsertTransactions('item_1', [transaction])
      expect(cache.getTransactionsByAccount('acc_1')[0].category).toEqual(['food_and_drink', 'coffee'])
    })

    it('leaves category undefined when not provided', () => {
      cache.upsertTransactions('item_1', [{ ...transaction, category: undefined }])
      expect(cache.getTransactionsByAccount('acc_1')[0].category).toBeUndefined()
    })

    it('getTransactionsByItem scopes to a single item', () => {
      cache.upsertTransactions('item_1', [transaction])
      cache.upsertTransactions('item_2', [{ ...transaction, id: 'txn_2', account_id: 'acc_2' }])
      expect(cache.getTransactionsByItem('item_1').map(r => r.id)).toEqual(['txn_1'])
    })
  })

  describe('cursors', () => {
    it('returns undefined for an item with no saved cursor', () => {
      expect(cache.getCursor('item_1')).toBeUndefined()
    })

    it('saves and reads back a cursor', () => {
      cache.saveCursor('item_1', 'cursor_abc')
      expect(cache.getCursor('item_1')).toBe('cursor_abc')
    })

    it('overwrites the cursor for the same item', () => {
      cache.saveCursor('item_1', 'cursor_1')
      cache.saveCursor('item_1', 'cursor_2')
      expect(cache.getCursor('item_1')).toBe('cursor_2')
    })

    it('tracks cursors independently per item', () => {
      cache.saveCursor('item_1', 'cursor_1')
      cache.saveCursor('item_2', 'cursor_2')
      expect(cache.getCursor('item_1')).toBe('cursor_1')
      expect(cache.getCursor('item_2')).toBe('cursor_2')
    })
  })

  it('persists across reopening the same db file', () => {
    cache.upsertAccounts('item_1', [account])
    cache.saveCursor('item_1', 'cursor_1')
    cache.close()

    const reopened = new PlaidCache({ dbPath, passphrase: TEST_PASSPHRASE })
    expect(reopened.getAllAccounts()).toHaveLength(1)
    expect(reopened.getCursor('item_1')).toBe('cursor_1')
    reopened.close()
  })

  describe('encryption at rest (D5.1)', () => {
    const MARKER = 'ZZZ_SECRET_MERCHANT_ZZZ'

    it('never writes financial data in cleartext to the DB or the raw file', () => {
      cache.upsertAccounts('item_1', [{ ...account, name: MARKER }])
      cache.upsertTransactions('item_1', [
        { ...transaction, description: MARKER, merchant_name: MARKER },
      ])
      cache.saveCursor('item_1', MARKER)
      cache.close()

      // (a) Open the file raw and confirm no text column in the cache tables
      // contains the marker — the encrypted blobs must not be readable as text.
      const raw = new DatabaseSync(dbPath)
      const accountText = raw
        .prepare('SELECT account_id, item_id FROM accounts_cache')
        .all() as Array<Record<string, unknown>>
      const txnText = raw
        .prepare('SELECT transaction_id, item_id, account_id FROM transactions_cache')
        .all() as Array<Record<string, unknown>>
      const containsMarker = (rows: Array<Record<string, unknown>>): boolean =>
        rows.some((row) => Object.values(row).some((v) => String(v).includes(MARKER)))
      expect(containsMarker(accountText)).toBe(false)
      expect(containsMarker(txnText)).toBe(false)
      raw.close()

      // (b) Read the raw bytes off disk and confirm the marker never appears.
      const bytes = readFileSync(dbPath)
      expect(bytes.includes(Buffer.from(MARKER, 'utf8'))).toBe(false)
    })

    it('round-trips the encrypted values back to the original plaintext', () => {
      cache.upsertAccounts('item_1', [{ ...account, name: MARKER }])
      cache.upsertTransactions('item_1', [
        { ...transaction, description: MARKER, merchant_name: MARKER },
      ])
      cache.saveCursor('item_1', MARKER)

      expect(cache.getAllAccounts()[0].name).toBe(MARKER)
      const [txn] = cache.getTransactionsByAccount('acc_1')
      expect(txn.description).toBe(MARKER)
      expect(txn.merchant_name).toBe(MARKER)
      expect(cache.getCursor('item_1')).toBe(MARKER)
    })

    it('throws TokenStoreKeyError when reopened with the wrong passphrase', () => {
      cache.upsertAccounts('item_1', [account])
      cache.close()

      expect(() => new PlaidCache({ dbPath, passphrase: 'a different passphrase' })).toThrow(
        TokenStoreKeyError
      )
      // Re-open with the correct passphrase so afterEach's close() is a no-op safe path.
      cache = new PlaidCache({ dbPath, passphrase: TEST_PASSPHRASE })
    })
  })

  describe('migration from the pre-D5.1 plaintext schema', () => {
    const MARKER = 'ZZZ_SECRET_MERCHANT_ZZZ'

    it('drops old plaintext rows, VACUUMs away the marker, and recreates encrypted tables', () => {
      const legacyDbPath = join(dir, 'legacy-plaid.sqlite')
      const legacyDb = new DatabaseSync(legacyDbPath)
      legacyDb.exec(`
        CREATE TABLE accounts_cache (
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
      legacyDb.exec(`
        CREATE TABLE transactions_cache (
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
      legacyDb.exec(`
        CREATE TABLE cursors (
          item_id TEXT PRIMARY KEY,
          cursor TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      legacyDb
        .prepare(
          `INSERT INTO accounts_cache (
            account_id, item_id, name, type, subtype, institution, mask,
            balance_current, balance_available, currency, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('acc_legacy', 'item_1', MARKER, 'checking', null, null, null, 100, null, 'USD', '2026-01-01T00:00:00.000Z')
      legacyDb.close()

      // Confirm the marker really is present in the plaintext file first.
      expect(readFileSync(legacyDbPath).includes(Buffer.from(MARKER, 'utf8'))).toBe(true)

      const migrated = new PlaidCache({ dbPath: legacyDbPath, passphrase: TEST_PASSPHRASE })
      // (a) Old rows are gone — re-fetchable by design.
      expect(migrated.getAllAccounts()).toHaveLength(0)
      // (b) VACUUM scrubbed the marker from the raw file.
      migrated.close()
      expect(readFileSync(legacyDbPath).includes(Buffer.from(MARKER, 'utf8'))).toBe(false)

      // And the recreated tables accept new encrypted writes.
      const reopened = new PlaidCache({ dbPath: legacyDbPath, passphrase: TEST_PASSPHRASE })
      reopened.upsertAccounts('item_1', [{ ...account, id: 'acc_new' }])
      expect(reopened.getAccount('acc_new')?.id).toBe('acc_new')
      reopened.close()
    })
  })

  describe('removeItem', () => {
    it('purges an item\'s accounts, transactions, and cursor', () => {
      cache.upsertAccounts('item_1', [account])
      cache.upsertTransactions('item_1', [transaction])
      cache.saveCursor('item_1', 'cursor_1')

      cache.removeItem('item_1')

      expect(cache.getAccountsByItem('item_1')).toHaveLength(0)
      expect(cache.getTransactionsByItem('item_1')).toHaveLength(0)
      expect(cache.getCursor('item_1')).toBeUndefined()
    })

    it('leaves other items\' cached data untouched', () => {
      cache.upsertAccounts('item_1', [account])
      cache.upsertTransactions('item_1', [transaction])
      cache.saveCursor('item_1', 'cursor_1')
      const otherAccount = { ...account, id: 'acc_2' }
      const otherTxn = { ...transaction, id: 'txn_2', account_id: 'acc_2' }
      cache.upsertAccounts('item_2', [otherAccount])
      cache.upsertTransactions('item_2', [otherTxn])
      cache.saveCursor('item_2', 'cursor_2')

      cache.removeItem('item_1')

      expect(cache.getAccountsByItem('item_2')).toHaveLength(1)
      expect(cache.getTransactionsByItem('item_2')).toHaveLength(1)
      expect(cache.getCursor('item_2')).toBe('cursor_2')
    })

    it('is a no-op for an item that has nothing cached', () => {
      expect(() => cache.removeItem('never-existed')).not.toThrow()
    })
  })
})
