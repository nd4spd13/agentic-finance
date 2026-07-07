import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account, Transaction } from '@clad/core'
import { PlaidCache } from '../src/cache.js'

describe('PlaidCache', () => {
  let dir: string
  let dbPath: string
  let cache: PlaidCache

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plaid-cache-test-'))
    dbPath = join(dir, 'plaid.sqlite')
    cache = new PlaidCache(dbPath)
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

    const reopened = new PlaidCache(dbPath)
    expect(reopened.getAllAccounts()).toHaveLength(1)
    expect(reopened.getCursor('item_1')).toBe('cursor_1')
    reopened.close()
  })
})
