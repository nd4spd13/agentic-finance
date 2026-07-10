import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderAuthError, ProviderUnavailableError, type TokenStore } from '@clad/core'
import { PlaidAdapter } from '../src/adapter.js'
import {
  checkingAccount,
  creditAccount,
  savingsAccount,
} from './fixtures/accounts.js'
import {
  accountsGetResponse,
  makeFakeClient,
  makeFakeTokenStore,
  makePlaidError,
  recurringResponse,
  respond,
  syncResponse,
} from './fixtures/fakes.js'
import { makePlaidTransaction } from './fixtures/transactions.js'

describe('PlaidAdapter (data retrieval, sync, cache, degradation)', () => {
  let dir: string
  let dbPath: string
  let tokenStore: TokenStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plaid-adapter-test-'))
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

  describe('getAccounts', () => {
    it('fetches, maps, and caches accounts from /accounts/get', async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn(() => respond(accountsGetResponse([checkingAccount, savingsAccount]))),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })

      const accounts = await adapter.getAccounts('user_1')

      expect(accounts).toHaveLength(2)
      expect(accounts.find(a => a.id === 'plaid_acc_checking')).toMatchObject({
        type: 'checking',
        balance_current: 1000.5,
      })
      expect(accounts.find(a => a.id === 'plaid_acc_savings')).toMatchObject({ type: 'savings' })
      expect(accounts.every(a => a.stale === undefined)).toBe(true)
    })

    it("populates institution from the owning item's institutionName", async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })

      const accounts = await adapter.getAccounts('user_1')
      expect(accounts[0].institution).toBe('Fake Bank')
    })

    it('aggregates accounts across multiple stored items', async () => {
      tokenStore.saveItem({
        itemId: 'item_2',
        institutionName: 'Second Bank',
        accessToken: 'access-sandbox-item2',
      })
      const client = makeFakeClient({
        accountsGet: vi.fn(async request => {
          if (request.access_token === 'access-sandbox-item1') {
            return respond(accountsGetResponse([checkingAccount]))
          }
          return respond(accountsGetResponse([creditAccount]))
        }),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })

      const accounts = await adapter.getAccounts('user_1')
      expect(accounts.map(a => a.id).sort()).toEqual(['plaid_acc_checking', 'plaid_acc_credit'])
      expect(accounts.find(a => a.id === 'plaid_acc_checking')?.institution).toBe('Fake Bank')
      expect(accounts.find(a => a.id === 'plaid_acc_credit')?.institution).toBe('Second Bank')
    })

    it('serves cached accounts with stale: true when Plaid is unreachable', async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn().mockResolvedValueOnce(await respond(accountsGetResponse([checkingAccount]))),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await adapter.getAccounts('user_1') // warm the cache

      const flakyClient = makeFakeClient({
        accountsGet: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      })
      const adapter2 = new PlaidAdapter({ client: flakyClient, tokenStore, dbPath })

      const accounts = await adapter2.getAccounts('user_1')
      expect(accounts).toHaveLength(1)
      expect(accounts[0].stale).toBe(true)
      expect(accounts[0].id).toBe('plaid_acc_checking')
      // institution survives the degrade-to-cache path.
      expect(accounts[0].institution).toBe('Fake Bank')
    })

    it('throws ProviderUnavailableError when Plaid fails and there is no cache', async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })

      await expect(adapter.getAccounts('user_1')).rejects.toBeInstanceOf(ProviderUnavailableError)
    })

    it('throws ProviderAuthError (carrying item_id, not the token) on ITEM_LOGIN_REQUIRED', async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn().mockRejectedValue(makePlaidError('ITEM_LOGIN_REQUIRED')),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })

      const error = await adapter.getAccounts('user_1').catch(e => e)
      expect(error).toBeInstanceOf(ProviderAuthError)
      expect((error as ProviderAuthError).item_id).toBe('item_1')
      expect(String(error)).not.toContain('access-sandbox-item1')
    })
  })

  describe('getBalance', () => {
    it('fetches the current balance via /accounts/balances/get', async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
        accountsBalanceGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await adapter.getAccounts('user_1') // populate accounts_cache so getBalance can route by accountId

      const balance = await adapter.getBalance('user_1', 'plaid_acc_checking')
      expect(balance).toMatchObject({
        account_id: 'plaid_acc_checking',
        current: 1000.5,
        available: 950.25,
        currency: 'USD',
      })
      expect(balance.stale).toBeUndefined()
      expect(typeof balance.last_updated).toBe('string')
    })

    it("getBalance's own accounts_cache write preserves institution (doesn't clobber it with a later refresh)", async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
        accountsBalanceGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await adapter.getAccounts('user_1') // warms the cache with institution: 'Fake Bank'
      await adapter.getBalance('user_1', 'plaid_acc_checking') // re-upserts via getBalance's own cache write

      // Degrade getAccounts to whatever is now in the cache to observe what
      // getBalance actually persisted.
      const flakyClient = makeFakeClient({ accountsGet: vi.fn().mockRejectedValue(new Error('down')) })
      const adapter2 = new PlaidAdapter({ client: flakyClient, tokenStore, dbPath })
      const accounts = await adapter2.getAccounts('user_1')
      expect(accounts[0].institution).toBe('Fake Bank')
    })

    it('serves the cached balance with stale: true when Plaid is unreachable', async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await adapter.getAccounts('user_1')

      const flakyClient = makeFakeClient({
        accountsGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
        accountsBalanceGet: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')),
      })
      const adapter2 = new PlaidAdapter({ client: flakyClient, tokenStore, dbPath })

      const balance = await adapter2.getBalance('user_1', 'plaid_acc_checking')
      expect(balance.stale).toBe(true)
      expect(balance.current).toBe(1000.5)
    })

    it('throws ProviderUnavailableError when there is no cache and the account is unknown', async () => {
      const client = makeFakeClient()
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await expect(adapter.getBalance('user_1', 'unknown_account')).rejects.toBeInstanceOf(
        ProviderUnavailableError
      )
    })
  })

  describe('getTransactions: sync pagination', () => {
    it('pages through has_more across 3 pages, persisting added transactions and the final cursor', async () => {
      const page1 = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't1', date: '2026-01-01' })],
        next_cursor: 'cursor_1',
        has_more: true,
      })
      const page2 = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't2', date: '2026-01-02' })],
        next_cursor: 'cursor_2',
        has_more: true,
      })
      const page3 = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't3', date: '2026-01-03' })],
        next_cursor: 'cursor_3',
        has_more: false,
      })

      const syncMock = vi
        .fn()
        .mockResolvedValueOnce(await respond(page1))
        .mockResolvedValueOnce(await respond(page2))
        .mockResolvedValueOnce(await respond(page3))

      const client = makeFakeClient({ transactionsSync: syncMock })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })

      const transactions = await adapter.getTransactions('user_1', 'plaid_acc_checking')

      expect(syncMock).toHaveBeenCalledTimes(3)
      expect(syncMock.mock.calls[0][0].cursor).toBeUndefined()
      expect(syncMock.mock.calls[1][0].cursor).toBe('cursor_1')
      expect(syncMock.mock.calls[2][0].cursor).toBe('cursor_2')
      expect(transactions.map(t => t.id).sort()).toEqual(['t1', 't2', 't3'])
    })

    it('persists modified transactions as updates', async () => {
      const initial = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't1', amount: 10, pending: true })],
        next_cursor: 'cursor_1',
        has_more: false,
      })
      const client = makeFakeClient({ transactionsSync: vi.fn().mockResolvedValueOnce(await respond(initial)) })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await adapter.getTransactions('user_1', 'plaid_acc_checking')

      const update = syncResponse({
        modified: [makePlaidTransaction({ transaction_id: 't1', amount: 10, pending: false })],
        next_cursor: 'cursor_2',
        has_more: false,
      })
      const client2 = makeFakeClient({ transactionsSync: vi.fn().mockResolvedValueOnce(await respond(update)) })
      const adapter2 = new PlaidAdapter({ client: client2, tokenStore, dbPath })
      const transactions = await adapter2.getTransactions('user_1', 'plaid_acc_checking')

      expect(transactions).toHaveLength(1)
      expect(transactions[0].pending).toBe(false)
    })

    it('removes deleted transactions from the cache', async () => {
      const initial = syncResponse({
        added: [
          makePlaidTransaction({ transaction_id: 't1' }),
          makePlaidTransaction({ transaction_id: 't2' }),
        ],
        next_cursor: 'cursor_1',
        has_more: false,
      })
      const client = makeFakeClient({ transactionsSync: vi.fn().mockResolvedValueOnce(await respond(initial)) })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await adapter.getTransactions('user_1', 'plaid_acc_checking')

      const removal = syncResponse({
        removed: [{ transaction_id: 't1', account_id: 'plaid_acc_checking' }],
        next_cursor: 'cursor_2',
        has_more: false,
      })
      const client2 = makeFakeClient({ transactionsSync: vi.fn().mockResolvedValueOnce(await respond(removal)) })
      const adapter2 = new PlaidAdapter({ client: client2, tokenStore, dbPath })
      const transactions = await adapter2.getTransactions('user_1', 'plaid_acc_checking')

      expect(transactions.map(t => t.id)).toEqual(['t2'])
    })

    it('resumes from the last saved cursor on a subsequent call', async () => {
      const first = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't1' })],
        next_cursor: 'cursor_1',
        has_more: false,
      })
      const syncMock1 = vi.fn().mockResolvedValueOnce(await respond(first))
      const client1 = makeFakeClient({ transactionsSync: syncMock1 })
      const adapter1 = new PlaidAdapter({ client: client1, tokenStore, dbPath })
      await adapter1.getTransactions('user_1', 'plaid_acc_checking')

      const second = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't2' })],
        next_cursor: 'cursor_2',
        has_more: false,
      })
      const syncMock2 = vi.fn().mockResolvedValueOnce(await respond(second))
      const client2 = makeFakeClient({ transactionsSync: syncMock2 })
      const adapter2 = new PlaidAdapter({ client: client2, tokenStore, dbPath })
      await adapter2.getTransactions('user_1', 'plaid_acc_checking')

      expect(syncMock2.mock.calls[0][0].cursor).toBe('cursor_1')
    })

    it('restarts the whole sync loop from the last saved cursor on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', async () => {
      // First call establishes a saved cursor at 'cursor_1'.
      const warm = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't0' })],
        next_cursor: 'cursor_1',
        has_more: false,
      })
      const warmClient = makeFakeClient({ transactionsSync: vi.fn().mockResolvedValueOnce(await respond(warm)) })
      const warmAdapter = new PlaidAdapter({ client: warmClient, tokenStore, dbPath })
      await warmAdapter.getTransactions('user_1', 'plaid_acc_checking')

      // Second call: page 1 succeeds and advances to cursor_2, page 2 throws
      // the mutation error. The adapter must restart from cursor_1 (the
      // last *saved* cursor before this call began) rather than cursor_2.
      const page1 = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't1' })],
        next_cursor: 'cursor_2',
        has_more: true,
      })
      const retryPage1 = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't1' })],
        next_cursor: 'cursor_2',
        has_more: true,
      })
      const retryPage2 = syncResponse({
        added: [makePlaidTransaction({ transaction_id: 't2' })],
        next_cursor: 'cursor_3',
        has_more: false,
      })

      const syncMock = vi
        .fn()
        .mockResolvedValueOnce(await respond(page1))
        .mockRejectedValueOnce(makePlaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'))
        .mockResolvedValueOnce(await respond(retryPage1))
        .mockResolvedValueOnce(await respond(retryPage2))

      const client = makeFakeClient({ transactionsSync: syncMock })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })

      const transactions = await adapter.getTransactions('user_1', 'plaid_acc_checking')

      expect(syncMock.mock.calls[0][0].cursor).toBe('cursor_1')
      expect(syncMock.mock.calls[2][0].cursor).toBe('cursor_1') // restarted from saved cursor, not cursor_2
      expect(transactions.map(t => t.id).sort()).toEqual(['t0', 't1', 't2'])
    })
  })

  describe('getTransactions: mapping and filters', () => {
    async function warmCache(transactions: ReturnType<typeof makePlaidTransaction>[]) {
      const client = makeFakeClient({
        transactionsSync: vi
          .fn()
          .mockResolvedValueOnce(
            await respond(syncResponse({ added: transactions, next_cursor: 'c1', has_more: false }))
          ),
      })
      return new PlaidAdapter({ client, tokenStore, dbPath })
    }

    it('applies inclusive start_date/end_date and sorts descending by date', async () => {
      const adapter = await warmCache([
        makePlaidTransaction({ transaction_id: 't1', date: '2026-01-01' }),
        makePlaidTransaction({ transaction_id: 't2', date: '2026-01-15' }),
        makePlaidTransaction({ transaction_id: 't3', date: '2026-02-01' }),
      ])

      const result = await adapter.getTransactions('user_1', 'plaid_acc_checking', {
        start_date: '2026-01-01',
        end_date: '2026-01-15',
      })

      expect(result.map(t => t.id)).toEqual(['t2', 't1'])
    })

    it('applies the count limit', async () => {
      const adapter = await warmCache([
        makePlaidTransaction({ transaction_id: 't1', date: '2026-01-01' }),
        makePlaidTransaction({ transaction_id: 't2', date: '2026-01-02' }),
        makePlaidTransaction({ transaction_id: 't3', date: '2026-01-03' }),
      ])

      const result = await adapter.getTransactions('user_1', 'plaid_acc_checking', { count: 2 })
      expect(result.map(t => t.id)).toEqual(['t3', 't2'])
    })

    it('only returns transactions for the requested account', async () => {
      const adapter = await warmCache([
        makePlaidTransaction({ transaction_id: 't1', account_id: 'plaid_acc_checking' }),
        makePlaidTransaction({ transaction_id: 't2', account_id: 'plaid_acc_savings' }),
      ])
      const result = await adapter.getTransactions('user_1', 'plaid_acc_checking')
      expect(result.map(t => t.id)).toEqual(['t1'])
    })
  })

  describe('getTransactions: degradation', () => {
    it('serves cached transactions with stale: true when sync fails', async () => {
      const warmClient = makeFakeClient({
        transactionsSync: vi
          .fn()
          .mockResolvedValueOnce(
            await respond(
              syncResponse({
                added: [makePlaidTransaction({ transaction_id: 't1' })],
                next_cursor: 'c1',
                has_more: false,
              })
            )
          ),
      })
      const warmAdapter = new PlaidAdapter({ client: warmClient, tokenStore, dbPath })
      await warmAdapter.getTransactions('user_1', 'plaid_acc_checking')

      const flakyClient = makeFakeClient({
        transactionsSync: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
      })
      const adapter2 = new PlaidAdapter({ client: flakyClient, tokenStore, dbPath })
      const result = await adapter2.getTransactions('user_1', 'plaid_acc_checking')

      expect(result).toHaveLength(1)
      expect(result[0].stale).toBe(true)
    })

    it('throws ProviderUnavailableError when sync fails and there is no cache', async () => {
      const client = makeFakeClient({
        transactionsSync: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await expect(adapter.getTransactions('user_1', 'plaid_acc_checking')).rejects.toBeInstanceOf(
        ProviderUnavailableError
      )
    })

    it('throws ProviderAuthError on ITEM_LOGIN_REQUIRED during sync', async () => {
      const client = makeFakeClient({
        transactionsSync: vi.fn().mockRejectedValue(makePlaidError('ITEM_LOGIN_REQUIRED')),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      const error = await adapter.getTransactions('user_1', 'plaid_acc_checking').catch(e => e)
      expect(error).toBeInstanceOf(ProviderAuthError)
      expect((error as ProviderAuthError).item_id).toBe('item_1')
    })
  })

  describe('getRecurringCharges', () => {
    it('maps outflow streams to RecurringCharge and ignores inflow streams', async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
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
              inflow_streams: [
                {
                  account_id: 'plaid_acc_checking',
                  stream_id: 'stream_2',
                  category: null,
                  category_id: null,
                  description: 'PAYROLL',
                  merchant_name: 'Employer',
                  first_date: '2026-01-01',
                  last_date: '2026-03-01',
                  predicted_next_date: '2026-04-01',
                  frequency: 'MONTHLY',
                  transaction_ids: ['t2'],
                  average_amount: { amount: 4500, iso_currency_code: 'USD' },
                  last_amount: { amount: 4500, iso_currency_code: 'USD' },
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
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await adapter.getAccounts('user_1') // populate accounts_cache for routing

      const charges = await adapter.getRecurringCharges('user_1', 'plaid_acc_checking')
      expect(charges).toHaveLength(1)
      expect(charges[0]).toMatchObject({
        description: 'Netflix',
        amount: 15.99,
        frequency: 'monthly',
        next_date: '2026-04-01',
        confidence: 'high',
        source: 'provider',
      })
    })

    it('throws ProviderUnavailableError when the account has no known owning item', async () => {
      const client = makeFakeClient()
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await expect(adapter.getRecurringCharges('user_1', 'unknown_account')).rejects.toBeInstanceOf(
        ProviderUnavailableError
      )
    })

    it('throws ProviderAuthError on ITEM_LOGIN_REQUIRED', async () => {
      const client = makeFakeClient({
        accountsGet: vi.fn(() => respond(accountsGetResponse([checkingAccount]))),
        transactionsRecurringGet: vi.fn().mockRejectedValue(makePlaidError('ITEM_LOGIN_REQUIRED')),
      })
      const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
      await adapter.getAccounts('user_1')

      const error = await adapter.getRecurringCharges('user_1', 'plaid_acc_checking').catch(e => e)
      expect(error).toBeInstanceOf(ProviderAuthError)
      expect((error as ProviderAuthError).item_id).toBe('item_1')
    })
  })
})
