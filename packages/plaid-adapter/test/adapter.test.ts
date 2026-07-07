import { describe, it, expect } from 'vitest'
import type { FinancialDataProvider } from '@clad/core'
import { PlaidAdapter } from '../src/adapter.js'
import type { PlaidClientLike } from '../src/plaid-client.types.js'
import type { StoredItemMeta, TokenStore } from '../src/token-store.types.js'

// Minimal fakes — WP2 only needs a skeleton that type-checks and throws
// NotImplemented. Real fakes with canned fixtures land in WP3/WP5.
function makeFakeClient(): PlaidClientLike {
  const notImplemented = () => {
    throw new Error('fake client method not implemented in this test')
  }
  return {
    linkTokenCreate: notImplemented,
    itemPublicTokenExchange: notImplemented,
    accountsGet: notImplemented,
    accountsBalanceGet: notImplemented,
    transactionsSync: notImplemented,
    transactionsRecurringGet: notImplemented,
    sandboxPublicTokenCreate: notImplemented,
  } as unknown as PlaidClientLike
}

function makeFakeTokenStore(): TokenStore {
  const items = new Map<string, StoredItemMeta & { accessToken: string }>()
  return {
    saveItem(item) {
      const now = new Date().toISOString()
      items.set(item.itemId, {
        itemId: item.itemId,
        institutionName: item.institutionName,
        accessToken: item.accessToken,
        createdAt: now,
        updatedAt: now,
      })
    },
    getAccessToken(itemId) {
      const found = items.get(itemId)
      if (!found) throw new Error('item not found')
      return found.accessToken
    },
    listItems() {
      return Array.from(items.values()).map(({ itemId, institutionName, createdAt, updatedAt }) => ({
        itemId,
        institutionName,
        createdAt,
        updatedAt,
      }))
    },
    deleteItem(itemId) {
      items.delete(itemId)
    },
    close() {
      /* no-op for fake */
    },
  }
}

describe('PlaidAdapter (skeleton)', () => {
  it('satisfies the FinancialDataProvider contract via constructor injection', () => {
    const adapter: FinancialDataProvider = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath: ':memory:',
    })

    expect(typeof adapter.getAccounts).toBe('function')
    expect(typeof adapter.getTransactions).toBe('function')
    expect(typeof adapter.getBalance).toBe('function')
    expect(typeof adapter.getRecurringCharges).toBe('function')
  })

  it('accepts an optional userId in constructor options', () => {
    const adapter = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath: ':memory:',
      userId: 'user123',
    })
    expect(adapter).toBeInstanceOf(PlaidAdapter)
  })

  it('getAccounts throws NotImplemented', async () => {
    const adapter = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath: ':memory:',
    })
    await expect(adapter.getAccounts('user123')).rejects.toThrow(/NotImplemented/)
  })

  it('getTransactions throws NotImplemented', async () => {
    const adapter = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath: ':memory:',
    })
    await expect(adapter.getTransactions('user123', 'acc_1')).rejects.toThrow(/NotImplemented/)
  })

  it('getBalance throws NotImplemented', async () => {
    const adapter = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath: ':memory:',
    })
    await expect(adapter.getBalance('user123', 'acc_1')).rejects.toThrow(/NotImplemented/)
  })

  it('getRecurringCharges throws NotImplemented', async () => {
    const adapter = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath: ':memory:',
    })
    await expect(adapter.getRecurringCharges('user123', 'acc_1')).rejects.toThrow(/NotImplemented/)
  })
})
