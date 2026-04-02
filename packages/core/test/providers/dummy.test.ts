import { describe, it, expect } from 'vitest'

describe('DummyDataProvider', () => {
  it('returns 3 realistic accounts (checking, savings, credit)', async () => {
    const { DummyDataProvider } = await import('../../src/providers/dummy.js')
    const provider = new DummyDataProvider()

    const accounts = await provider.getAccounts('user123')
    expect(accounts).toHaveLength(3)
    expect(accounts.map(a => a.type)).toContain('checking')
    expect(accounts.map(a => a.type)).toContain('savings')
    expect(accounts.map(a => a.type)).toContain('credit')
  })

  it('returns realistic transactions with recognizable merchants', async () => {
    const { DummyDataProvider } = await import('../../src/providers/dummy.js')
    const provider = new DummyDataProvider()

    const accounts = await provider.getAccounts('user123')
    const transactions = await provider.getTransactions('user123', accounts[0].id)

    expect(transactions.length).toBeGreaterThan(0)
    const merchants = transactions.map(t => t.merchant_name).filter(Boolean)
    expect(merchants.some(m => ['Netflix', 'Spotify', 'Amazon'].includes(m))).toBe(true)
  })

  it('balances consistent with transaction history', async () => {
    const { DummyDataProvider } = await import('../../src/providers/dummy.js')
    const provider = new DummyDataProvider()

    const accounts = await provider.getAccounts('user123')
    const checking = accounts.find(a => a.type === 'checking')!

    const balance = await provider.getBalance('user123', checking.id)
    expect(balance.current).toBe(checking.balance_current)
  })

  it('recurring charges detected', async () => {
    const { DummyDataProvider } = await import('../../src/providers/dummy.js')
    const provider = new DummyDataProvider()

    const accounts = await provider.getAccounts('user123')
    const recurring = await provider.getRecurringCharges!('user123', accounts[0].id)

    expect(recurring).toBeDefined()
    expect(recurring.length).toBeGreaterThan(0)
    expect(recurring[0].frequency).toMatch(/weekly|biweekly|monthly|annually/)
  })

  it('deterministic (same calls = same data)', async () => {
    const { DummyDataProvider } = await import('../../src/providers/dummy.js')
    const provider1 = new DummyDataProvider()
    const provider2 = new DummyDataProvider()

    const accounts1 = await provider1.getAccounts('user123')
    const accounts2 = await provider2.getAccounts('user123')

    expect(accounts1).toEqual(accounts2)
  })
})
