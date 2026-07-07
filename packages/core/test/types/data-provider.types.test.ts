import { describe, it, expect, expectTypeOf } from 'vitest'
import type { FinancialDataProvider, DataProvider, Account, Transaction, Balance } from '../../src/types/index.js'

describe('FinancialDataProvider (rename from DataProvider)', () => {
  it('DummyDataProvider satisfies the FinancialDataProvider contract', async () => {
    const { DummyDataProvider } = await import('../../src/providers/dummy.js')
    const provider: FinancialDataProvider = new DummyDataProvider()

    expect(typeof provider.getAccounts).toBe('function')
    expect(typeof provider.getTransactions).toBe('function')
    expect(typeof provider.getBalance).toBe('function')
  })

  it('DataProvider remains available as a deprecated alias of FinancialDataProvider', () => {
    // Type-level check: DataProvider and FinancialDataProvider must be structurally identical.
    expectTypeOf<DataProvider>().toEqualTypeOf<FinancialDataProvider>()
  })

  it('Account, Transaction, and Balance accept an optional stale flag', () => {
    const account: Account = {
      id: 'acc_1',
      name: 'Test',
      type: 'checking',
      balance_current: 1,
      currency: 'USD',
      stale: true,
    }
    const transaction: Transaction = {
      id: 'txn_1',
      account_id: 'acc_1',
      amount: -1,
      date: '2026-01-01',
      description: 'Test',
      pending: false,
      stale: true,
    }
    const balance: Balance = {
      account_id: 'acc_1',
      current: 1,
      currency: 'USD',
      last_updated: '2026-01-01T00:00:00.000Z',
      stale: true,
    }

    expect(account.stale).toBe(true)
    expect(transaction.stale).toBe(true)
    expect(balance.stale).toBe(true)

    // stale is optional — absence must still type-check
    const freshAccount: Account = {
      id: 'acc_2',
      name: 'Test2',
      type: 'savings',
      balance_current: 1,
      currency: 'USD',
    }
    expect(freshAccount.stale).toBeUndefined()
  })
})
