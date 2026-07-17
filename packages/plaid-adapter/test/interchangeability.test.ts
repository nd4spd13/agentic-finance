import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DummyDataProvider, type FinancialDataProvider, type TokenStore } from '@clad/core'
import { PlaidAdapter } from '../src/adapter.js'
import { checkingAccount } from './fixtures/accounts.js'
import {
  accountsGetResponse,
  makeFakeClient,
  makeFakeTokenStore,
  recurringResponse,
  respond,
  syncResponse,
} from './fixtures/fakes.js'
import { makePlaidTransaction } from './fixtures/transactions.js'

/**
 * Runs the same call sequence against `DummyDataProvider` and a faked
 * `PlaidAdapter`, asserting both satisfy the `FinancialDataProvider`
 * contract and share the same return-shape invariants. This is what makes
 * the two providers interchangeable at the mcp-server composition root
 * (architecture decision #3).
 */
const TEST_PASSPHRASE = 'cache-encryption-test-passphrase'

describe('DummyDataProvider <-> PlaidAdapter interchangeability', () => {
  let dir: string
  let dbPath: string
  let tokenStore: TokenStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plaid-interop-test-'))
    dbPath = join(dir, 'plaid.sqlite')
    tokenStore = makeFakeTokenStore()
    tokenStore.saveItem({
      itemId: 'item_1',
      institutionName: 'Fake Bank',
      accessToken: 'access-sandbox-item1',
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makePlaidProvider(): FinancialDataProvider {
    const client = makeFakeClient({
      accountsGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
      accountsBalanceGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
      transactionsSync: vi.fn().mockResolvedValueOnce(
        respond(
          syncResponse({
            added: [
              makePlaidTransaction({ transaction_id: 't1', date: '2026-01-01', amount: 20 }),
              makePlaidTransaction({ transaction_id: 't2', date: '2026-01-02', amount: -50 }),
            ],
            next_cursor: 'cursor_1',
            has_more: false,
          })
        )
      ),
      transactionsRecurringGet: vi.fn(() =>
        respond(
          recurringResponse({
            outflow_streams: [
              {
                account_id: 'plaid_acc_checking',
                stream_id: 'stream_1',
                category: null,
                category_id: null,
                description: 'NETFLIX.COM',
                merchant_name: 'Netflix',
                first_date: '2026-01-01',
                last_date: '2026-03-01',
                predicted_next_date: '2026-04-01',
                frequency: 'MONTHLY',
                transaction_ids: ['t1'],
                average_amount: { amount: 15.99, iso_currency_code: 'USD' },
                last_amount: { amount: 15.99, iso_currency_code: 'USD' },
                is_active: true,
                status: 'MATURE',
                personal_finance_category: null,
                is_user_modified: false,
              } as never,
            ],
          })
        )
      ),
    })
    return new PlaidAdapter({ client, tokenStore, dbPath, passphrase: TEST_PASSPHRASE })
  }

  const providers: Array<[string, () => FinancialDataProvider]> = [
    ['DummyDataProvider', () => new DummyDataProvider()],
    ['PlaidAdapter', makePlaidProvider],
  ]

  it.each(providers)('%s satisfies FinancialDataProvider structurally', (_name, factory) => {
    const provider = factory()
    expect(typeof provider.getAccounts).toBe('function')
    expect(typeof provider.getTransactions).toBe('function')
    expect(typeof provider.getBalance).toBe('function')
    expect(typeof provider.getRecurringCharges).toBe('function')
  })

  it.each(providers)('%s: getAccounts returns well-shaped Account[]', async (_name, factory) => {
    const provider = factory()
    const accounts = await provider.getAccounts('user_1')

    expect(Array.isArray(accounts)).toBe(true)
    expect(accounts.length).toBeGreaterThan(0)
    for (const account of accounts) {
      expect(typeof account.id).toBe('string')
      expect(typeof account.name).toBe('string')
      expect(['checking', 'savings', 'credit', 'loan', 'investment']).toContain(account.type)
      expect(typeof account.balance_current).toBe('number')
      expect(typeof account.currency).toBe('string')
    }
  })

  it.each(providers)(
    '%s: getTransactions returns well-shaped Transaction[] honoring count',
    async (_name, factory) => {
      const provider = factory()
      const accounts = await provider.getAccounts('user_1')
      const accountId = accounts[0].id

      const transactions = await provider.getTransactions('user_1', accountId, { count: 1 })
      expect(Array.isArray(transactions)).toBe(true)
      expect(transactions.length).toBeLessThanOrEqual(1)
      for (const txn of transactions) {
        expect(typeof txn.id).toBe('string')
        expect(txn.account_id).toBe(accountId)
        expect(typeof txn.amount).toBe('number')
        expect(typeof txn.date).toBe('string')
        expect(typeof txn.description).toBe('string')
        expect(typeof txn.pending).toBe('boolean')
      }
    }
  )

  it.each(providers)('%s: getBalance returns a well-shaped Balance', async (_name, factory) => {
    const provider = factory()
    const accounts = await provider.getAccounts('user_1')
    const accountId = accounts[0].id

    const balance = await provider.getBalance('user_1', accountId)
    expect(balance.account_id).toBe(accountId)
    expect(typeof balance.current).toBe('number')
    expect(typeof balance.currency).toBe('string')
    expect(typeof balance.last_updated).toBe('string')
  })

  it.each(providers)(
    '%s: getRecurringCharges returns well-shaped RecurringCharge[]',
    async (_name, factory) => {
      const provider = factory()
      const accounts = await provider.getAccounts('user_1')
      const accountId = accounts[0].id

      const charges = await provider.getRecurringCharges!('user_1', accountId)
      expect(Array.isArray(charges)).toBe(true)
      for (const charge of charges) {
        expect(typeof charge.description).toBe('string')
        expect(typeof charge.amount).toBe('number')
        expect(['weekly', 'biweekly', 'monthly', 'annually']).toContain(charge.frequency)
        expect(typeof charge.next_date).toBe('string')
        expect(['high', 'medium', 'low']).toContain(charge.confidence)
        expect(['provider', 'pattern_match', 'manual']).toContain(charge.source)
      }
    }
  )
})
