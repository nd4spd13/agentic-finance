import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FinancialDataProvider, StoredItemMeta, TokenStore } from '@clad/core'
import { ProviderUnavailableError } from '@clad/core'
import { PlaidAdapter } from '../src/adapter.js'
import type { PlaidClientLike } from '../src/plaid-client.types.js'

// Minimal fakes — see test/fixtures/fakes.ts for the richer versions used by
// adapter-data.test.ts and interchangeability.test.ts. This file just
// verifies the constructor-injection skeleton from WP2 and that WP5's
// implementations behave sanely with no stored items / no cache (the
// "nothing configured yet" state a freshly-scaffolded adapter starts in).
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
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plaid-adapter-skeleton-test-'))
    dbPath = join(dir, 'plaid.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('satisfies the FinancialDataProvider contract via constructor injection', () => {
    const adapter: FinancialDataProvider = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath,
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
      dbPath,
      userId: 'user123',
    })
    expect(adapter).toBeInstanceOf(PlaidAdapter)
  })

  it('getAccounts with no stored items and no cache returns an empty list', async () => {
    const adapter = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath,
    })
    await expect(adapter.getAccounts('user123')).resolves.toEqual([])
  })

  it('getTransactions with no stored items and no cache returns an empty list', async () => {
    const adapter = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath,
    })
    await expect(adapter.getTransactions('user123', 'acc_1')).resolves.toEqual([])
  })

  it('getBalance throws ProviderUnavailableError for an unknown account with no cache', async () => {
    const adapter = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath,
    })
    await expect(adapter.getBalance('user123', 'acc_1')).rejects.toBeInstanceOf(ProviderUnavailableError)
  })

  it('getRecurringCharges throws ProviderUnavailableError for an unknown account', async () => {
    const adapter = new PlaidAdapter({
      client: makeFakeClient(),
      tokenStore: makeFakeTokenStore(),
      dbPath,
    })
    await expect(adapter.getRecurringCharges('user123', 'acc_1')).rejects.toBeInstanceOf(
      ProviderUnavailableError
    )
  })
})
