import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ProviderAuthError,
  ProviderUnavailableError,
  type FinancialDataProvider,
  type StoredItemInput,
  type StoredItemMeta,
  type TokenStore,
} from '@clad/core'
import { SimpleFinAdapter } from '../src/adapter.js'
import { MAX_WINDOW_SECONDS, type FetchLike } from '../src/client.js'

function loadFixtureText(name: string): string {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  return readFileSync(path, 'utf-8')
}

const plainFixtureText = loadFixtureText('accounts-v2-plain.json')

const ACCESS_URL_1 = 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/item1'
const ACCESS_URL_2 = 'https://sfin-user2:sfin-p4ss2@bridge.example.org/simplefin/access/item2'

const HOUR = 60 * 60 * 1000

/** A mutable fake clock injected via `SimpleFinAdapterOptions.now`. */
function makeFakeClock(startIso: string) {
  let current = new Date(startIso)
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

/**
 * In-memory `TokenStore` fake — mirrors plaid-adapter's test fakes (see its
 * `test/fixtures/fakes.ts`).
 *
 * `now` stamps `createdAt`, which the adapter's setup grace window measures
 * against. It defaults to the *real* clock deliberately: a test using a fake
 * clock set years in the past then gets a `createdAt` in its future, which
 * the grace window reads as unusable and skips (failing closed to the normal
 * interval). That keeps every pre-existing test measuring the plain 6h gate,
 * exactly as it did before the grace window existed. Grace-window tests pass
 * the fake clock explicitly to opt in.
 */
function makeFakeTokenStore(now: () => Date = () => new Date()): TokenStore {
  const items = new Map<string, StoredItemMeta & { accessToken: string }>()
  return {
    saveItem(item: StoredItemInput) {
      const stampedAt = now().toISOString()
      items.set(item.itemId, {
        itemId: item.itemId,
        institutionName: item.institutionName,
        accessToken: item.accessToken,
        createdAt: stampedAt,
        updatedAt: stampedAt,
      })
    },
    getAccessToken(itemId: string) {
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
    deleteItem(itemId: string) {
      items.delete(itemId)
    },
    close() {
      /* no-op for fake */
    },
  }
}

interface RecordedCall {
  url: string
}

/**
 * Fake `fetch` that routes on a URL substring (each test's access URLs are
 * distinct enough to disambiguate which stored item a request belongs to)
 * to a per-route handler. A route can return a JSON body (200), an explicit
 * `Response` (e.g. a non-2xx status), or throw/reject to simulate a network
 * failure — matching `fetchAccounts`'s own error-mapping behavior.
 */
function makeFakeFetch(routes: Record<string, () => unknown>): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: unknown) => {
    const url = String(input)
    calls.push({ url })
    for (const [marker, handler] of Object.entries(routes)) {
      if (url.includes(marker)) {
        const result = handler()
        if (result instanceof Response) return result
        return new Response(JSON.stringify(result), { status: 200 })
      }
    }
    throw new Error(`unexpected fetch to ${url}`)
  }) as FetchLike
  return { fetch: fetchImpl, calls }
}

describe('SimpleFinAdapter (skeleton)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simplefin-adapter-skeleton-test-'))
    dbPath = join(dir, 'simplefin.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('satisfies the FinancialDataProvider contract via constructor injection', () => {
    const adapter: FinancialDataProvider = new SimpleFinAdapter({
      tokenStore: makeFakeTokenStore(),
      dbPath,
    })

    expect(typeof adapter.getAccounts).toBe('function')
    expect(typeof adapter.getTransactions).toBe('function')
    expect(typeof adapter.getBalance).toBe('function')
  })

  it('accepts an optional userId in constructor options', () => {
    const adapter = new SimpleFinAdapter({
      tokenStore: makeFakeTokenStore(),
      dbPath,
      userId: 'user123',
    })
    expect(adapter).toBeInstanceOf(SimpleFinAdapter)
  })

  it('does not implement getRecurringCharges (SimpleFIN protocol has no analog; optional on the interface)', () => {
    const adapter: FinancialDataProvider = new SimpleFinAdapter({
      tokenStore: makeFakeTokenStore(),
      dbPath,
    })
    expect(adapter.getRecurringCharges).toBeUndefined()
  })

  it('getAccounts with no stored items and no cache returns an empty list', async () => {
    const adapter = new SimpleFinAdapter({ tokenStore: makeFakeTokenStore(), dbPath })
    await expect(adapter.getAccounts('user123')).resolves.toEqual([])
  })

  it('getTransactions with no stored items and no cache returns an empty list', async () => {
    const adapter = new SimpleFinAdapter({ tokenStore: makeFakeTokenStore(), dbPath })
    await expect(adapter.getTransactions('user123', 'simplefin:acc_1')).resolves.toEqual([])
  })

  it('getBalance throws ProviderUnavailableError for an unknown account with no cache', async () => {
    const adapter = new SimpleFinAdapter({ tokenStore: makeFakeTokenStore(), dbPath })
    await expect(adapter.getBalance('user123', 'simplefin:acc_1')).rejects.toBeInstanceOf(
      ProviderUnavailableError
    )
  })
})

describe('SimpleFinAdapter (data retrieval, real SF1 fixtures)', () => {
  let dir: string
  let dbPath: string
  let tokenStore: TokenStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simplefin-adapter-data-test-'))
    dbPath = join(dir, 'simplefin.sqlite')
    tokenStore = makeFakeTokenStore()
    tokenStore.saveItem({
      itemId: 'item_1',
      institutionName: 'SimpleFIN',
      accessToken: ACCESS_URL_1,
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('fetches, maps, and caches accounts from /accounts on the first call', async () => {
    const { fetch } = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = new SimpleFinAdapter({ tokenStore, dbPath, fetch })

    const accounts = await adapter.getAccounts('user_1')

    expect(accounts).toHaveLength(3)
    expect(accounts.find((a) => a.id === 'simplefin:fixture-acct-savings')).toMatchObject({
      type: 'savings',
      balance_current: 114405.51,
      balance_available: 114405.51,
      institution: 'SimpleFIN Bridge',
    })
    expect(accounts.find((a) => a.id === 'simplefin:fixture-acct-checking')).toMatchObject({
      type: 'checking',
      balance_current: 24668.87,
    })
    // Issue B regression: institution must never leak onto subtype.
    expect(accounts.every((a) => a.subtype === undefined)).toBe(true)
    expect(accounts.every((a) => a.stale === undefined)).toBe(true)
  })

  it('resolves a specific account balance, bootstrapping the cache on a cold start', async () => {
    const { fetch } = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = new SimpleFinAdapter({ tokenStore, dbPath, fetch })

    const balance = await adapter.getBalance('user_1', 'simplefin:fixture-acct-checking')

    expect(balance).toMatchObject({
      account_id: 'simplefin:fixture-acct-checking',
      current: 24668.87,
      available: 24668.87,
      currency: 'USD',
    })
    expect(balance.stale).toBeUndefined()
    expect(typeof balance.last_updated).toBe('string')
  })

  it('resolves transactions for a specific account, bootstrapping the cache on a cold start', async () => {
    const { fetch } = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = new SimpleFinAdapter({ tokenStore, dbPath, fetch })

    const transactions = await adapter.getTransactions('user_1', 'simplefin:fixture-acct-savings')

    expect(transactions).toHaveLength(4)
    expect(transactions.every((t) => t.account_id === 'simplefin:fixture-acct-savings')).toBe(true)
    // "Fishing bait" appears twice in the fixture (different dates/amounts) — match the
    // specific, namespaced transaction id rather than the (non-unique) description.
    expect(transactions.find((t) => t.id === 'simplefin:fixture-acct-savings:1783497600')).toMatchObject({
      amount: -40,
      merchant_name: "John's Fishin Shack",
    })
  })

  it('honors TransactionQueryOpts.count against the cache', async () => {
    const { fetch } = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = new SimpleFinAdapter({ tokenStore, dbPath, fetch })

    const transactions = await adapter.getTransactions('user_1', 'simplefin:fixture-acct-savings', {
      count: 2,
    })
    expect(transactions).toHaveLength(2)
  })

  it('aggregates accounts across multiple stored items', async () => {
    tokenStore.saveItem({
      itemId: 'item_2',
      institutionName: 'SimpleFIN',
      accessToken: ACCESS_URL_2,
    })
    const { fetch } = makeFakeFetch({
      item1: () => JSON.parse(plainFixtureText),
      item2: () => ({
        errlist: [],
        accounts: [
          {
            id: 'fixture-acct-second-item',
            name: 'Second Item Checking',
            currency: 'USD',
            balance: '500.00',
            'available-balance': '500.00',
            'balance-date': 1783555200,
            transactions: [],
            holdings: [],
            conn_id: 'fixture-conn-second',
          },
        ],
        connections: [
          {
            conn_id: 'fixture-conn-second',
            name: 'Second',
            org_id: 'org-second',
            org_name: 'Second Bank',
          },
        ],
      }),
    })
    const adapter = new SimpleFinAdapter({ tokenStore, dbPath, fetch })

    const accounts = await adapter.getAccounts('user_1')
    expect(accounts.map((a) => a.id).sort()).toEqual([
      'simplefin:fixture-acct-checking',
      'simplefin:fixture-acct-empty',
      'simplefin:fixture-acct-savings',
      'simplefin:fixture-acct-second-item',
    ])
    expect(accounts.find((a) => a.id === 'simplefin:fixture-acct-second-item')?.institution).toBe(
      'Second Bank'
    )
  })
})

describe('SimpleFinAdapter (quota guardrail: shouldRefresh gates every live call)', () => {
  let dir: string
  let dbPath: string
  let tokenStore: TokenStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simplefin-adapter-quota-test-'))
    dbPath = join(dir, 'simplefin.sqlite')
    tokenStore = makeFakeTokenStore()
    tokenStore.saveItem({ itemId: 'item_1', institutionName: 'SimpleFIN', accessToken: ACCESS_URL_1 })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not call fetch again within minRefreshIntervalMs, across getAccounts/getBalance/getTransactions', async () => {
    const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
    const { fetch, calls } = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch,
      now: clock.now,
      minRefreshIntervalMs: HOUR,
    })

    await adapter.getAccounts('user_1')
    expect(calls).toHaveLength(1)

    clock.advance(30 * 60 * 1000) // 30 min later, still within the 1h interval
    await adapter.getBalance('user_1', 'simplefin:fixture-acct-checking')
    await adapter.getTransactions('user_1', 'simplefin:fixture-acct-savings')
    await adapter.getAccounts('user_1')

    expect(calls).toHaveLength(1) // no additional network calls
  })

  it('calls fetch again once minRefreshIntervalMs has elapsed', async () => {
    const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
    const { fetch, calls } = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch,
      now: clock.now,
      minRefreshIntervalMs: HOUR,
    })

    await adapter.getAccounts('user_1')
    expect(calls).toHaveLength(1)

    clock.advance(2 * HOUR)
    await adapter.getAccounts('user_1')
    expect(calls).toHaveLength(2)
  })

  it('requests the protocol-maximum window and pending=1 on every live fetch (full-replace eviction safety)', async () => {
    const clock = makeFakeClock('2026-04-01T00:00:00.000Z')
    const { fetch, calls } = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = new SimpleFinAdapter({ tokenStore, dbPath, fetch, now: clock.now })

    await adapter.getAccounts('user_1')

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url)
    const startDate = Number(url.searchParams.get('start-date'))
    const endDate = Number(url.searchParams.get('end-date'))
    expect(url.searchParams.get('pending')).toBe('1')
    expect(url.searchParams.get('version')).toBe('2')
    expect(endDate - startDate).toBe(MAX_WINDOW_SECONDS)
    expect(endDate).toBe(Math.floor(clock.now().getTime() / 1000))
  })
})

describe('SimpleFinAdapter (degradation to cache)', () => {
  let dir: string
  let dbPath: string
  let tokenStore: TokenStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simplefin-adapter-degrade-test-'))
    dbPath = join(dir, 'simplefin.sqlite')
    tokenStore = makeFakeTokenStore()
    tokenStore.saveItem({ itemId: 'item_1', institutionName: 'SimpleFIN', accessToken: ACCESS_URL_1 })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves cached accounts with stale: true when SimpleFIN is unreachable on a due refresh', async () => {
    const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
    const warm = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter1 = new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch: warm.fetch,
      now: clock.now,
      minRefreshIntervalMs: HOUR,
    })
    await adapter1.getAccounts('user_1') // warm the cache

    clock.advance(2 * HOUR) // now due for refresh
    const flaky = makeFakeFetch({
      item1: () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const adapter2 = new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch: flaky.fetch,
      now: clock.now,
      minRefreshIntervalMs: HOUR,
    })

    const accounts = await adapter2.getAccounts('user_1')
    expect(accounts).toHaveLength(3)
    expect(accounts.every((a) => a.stale === true)).toBe(true)
  })

  it('throws ProviderUnavailableError when SimpleFIN fails and there is no cache at all', async () => {
    const flaky = makeFakeFetch({
      item1: () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const adapter = new SimpleFinAdapter({ tokenStore, dbPath, fetch: flaky.fetch })
    await expect(adapter.getAccounts('user_1')).rejects.toBeInstanceOf(ProviderUnavailableError)
  })

  it('degrades gracefully (a redacted, non-throwing message) on an HTTP 402 subscription-lapsed response, once cache exists', async () => {
    const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
    const warm = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter1 = new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch: warm.fetch,
      now: clock.now,
      minRefreshIntervalMs: HOUR,
    })
    await adapter1.getAccounts('user_1')

    clock.advance(2 * HOUR)
    const lapsed = makeFakeFetch({
      item1: () => new Response('', { status: 402 }),
    })
    const adapter2 = new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch: lapsed.fetch,
      now: clock.now,
      minRefreshIntervalMs: HOUR,
    })

    const accounts = await adapter2.getAccounts('user_1')
    expect(accounts).toHaveLength(3)
    expect(accounts.every((a) => a.stale === true)).toBe(true)
  })
})

describe('SimpleFinAdapter (auth errors)', () => {
  let dir: string
  let dbPath: string
  let tokenStore: TokenStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simplefin-adapter-auth-test-'))
    dbPath = join(dir, 'simplefin.sqlite')
    tokenStore = makeFakeTokenStore()
    tokenStore.saveItem({ itemId: 'item_1', institutionName: 'SimpleFIN', accessToken: ACCESS_URL_1 })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('propagates ProviderAuthError on HTTP 403, carrying the itemId, instead of degrading to cache', async () => {
    const rejected = makeFakeFetch({
      item1: () => new Response('', { status: 403 }),
    })
    const adapter = new SimpleFinAdapter({ tokenStore, dbPath, fetch: rejected.fetch })

    const error = await adapter.getAccounts('user_1').then(
      () => {
        throw new Error('expected getAccounts to reject')
      },
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(ProviderAuthError)
    expect((error as ProviderAuthError).item_id).toBe('item_1')
  })

  it('propagates ProviderAuthError on HTTP 403 even when a fresh cache already exists', async () => {
    const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
    const warm = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter1 = new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch: warm.fetch,
      now: clock.now,
      minRefreshIntervalMs: HOUR,
    })
    await adapter1.getAccounts('user_1')

    clock.advance(2 * HOUR) // due for refresh
    const revoked = makeFakeFetch({ item1: () => new Response('', { status: 403 }) })
    const adapter2 = new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch: revoked.fetch,
      now: clock.now,
      minRefreshIntervalMs: HOUR,
    })

    await expect(adapter2.getAccounts('user_1')).rejects.toBeInstanceOf(ProviderAuthError)
  })

  it('never leaks the access URL userinfo in a ProviderAuthError message', async () => {
    const rejected = makeFakeFetch({ item1: () => new Response('', { status: 403 }) })
    const adapter = new SimpleFinAdapter({ tokenStore, dbPath, fetch: rejected.fetch })

    const error = await adapter.getAccounts('user_1').catch((e: unknown) => e)
    expect((error as Error).message).not.toContain('sfin-user')
    expect((error as Error).message).not.toContain('sfin-p4ss')
  })
})

describe('SimpleFinAdapter: setup grace window', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simplefin-adapter-grace-test-'))
    dbPath = join(dir, 'simplefin.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** An adapter whose token store shares the fake clock, so `createdAt` lands inside the grace window. */
  function makeGraceAdapter(clock: ReturnType<typeof makeFakeClock>, fetchImpl: FetchLike) {
    const tokenStore = makeFakeTokenStore(clock.now)
    tokenStore.saveItem({
      itemId: 'item_1',
      institutionName: 'SimpleFIN Bridge',
      accessToken: ACCESS_URL_1,
    })
    return new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch: fetchImpl,
      now: clock.now,
      minRefreshIntervalMs: 6 * HOUR,
      setupGraceMs: HOUR,
      setupGraceIntervalMs: 10 * 60 * 1000,
    })
  }

  it('refetches at the grace interval within the window, where the 6h gate would refuse', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = makeGraceAdapter(clock, fake.fetch)

    await adapter.getAccounts('user_1')
    expect(fake.calls).toHaveLength(1) // first-ever fetch

    // 10 minutes later: inside the grace window, so a user who linked another
    // institution on the Bridge sees it without waiting six hours.
    clock.advance(10 * 60 * 1000)
    await adapter.getAccounts('user_1')
    expect(fake.calls).toHaveLength(2)
  })

  it('still honors the grace interval as a floor (no fetch-per-call inside the window)', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = makeGraceAdapter(clock, fake.fetch)

    await adapter.getAccounts('user_1')
    clock.advance(60 * 1000) // 1 minute — well inside the 10min grace interval

    await adapter.getAccounts('user_1')
    await adapter.getAccounts('user_1')
    expect(fake.calls).toHaveLength(1)
  })

  it('reverts to the normal interval once the window has passed', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = makeGraceAdapter(clock, fake.fetch)

    await adapter.getAccounts('user_1')
    clock.advance(HOUR + 1) // grace window over
    await adapter.getAccounts('user_1')
    const afterGrace = fake.calls.length

    // 10 minutes would have refetched during grace; now it must not.
    clock.advance(10 * 60 * 1000)
    await adapter.getAccounts('user_1')
    expect(fake.calls).toHaveLength(afterGrace)

    clock.advance(6 * HOUR)
    await adapter.getAccounts('user_1')
    expect(fake.calls).toHaveLength(afterGrace + 1)
  })

  it('is disabled by setupGraceMs: 0', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const tokenStore = makeFakeTokenStore(clock.now)
    tokenStore.saveItem({
      itemId: 'item_1',
      institutionName: 'SimpleFIN Bridge',
      accessToken: ACCESS_URL_1,
    })
    const adapter = new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch: fake.fetch,
      now: clock.now,
      minRefreshIntervalMs: 6 * HOUR,
      setupGraceMs: 0,
    })

    await adapter.getAccounts('user_1')
    clock.advance(10 * 60 * 1000)
    await adapter.getAccounts('user_1')
    expect(fake.calls).toHaveLength(1)
  })
})

describe('SimpleFinAdapter: forceRefresh / getRefreshStatus', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simplefin-adapter-force-test-'))
    dbPath = join(dir, 'simplefin.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeAdapter(clock: ReturnType<typeof makeFakeClock>, fetchImpl: FetchLike) {
    const tokenStore = makeFakeTokenStore()
    tokenStore.saveItem({
      itemId: 'item_1',
      institutionName: 'SimpleFIN Bridge',
      accessToken: ACCESS_URL_1,
    })
    return new SimpleFinAdapter({
      tokenStore,
      dbPath,
      fetch: fetchImpl,
      now: clock.now,
      minRefreshIntervalMs: 6 * HOUR,
    })
  }

  it('fetches inside the cooldown that an automatic refresh would refuse', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = makeAdapter(clock, fake.fetch)

    await adapter.getAccounts('user_1')
    expect(fake.calls).toHaveLength(1)

    // 5 minutes in: the 6h gate refuses, but explicit user intent is the one
    // signal we get that the Bridge-side account set may have changed.
    clock.advance(5 * 60 * 1000)
    await adapter.getAccounts('user_1')
    expect(fake.calls).toHaveLength(1)

    const result = await adapter.forceRefresh()
    expect(fake.calls).toHaveLength(2)
    expect(result.refreshed).toEqual(['item_1'])
    expect(result.skipped).toEqual([])
  })

  it('floors repeated force refreshes at one minute', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = makeAdapter(clock, fake.fetch)

    await adapter.forceRefresh()
    expect(fake.calls).toHaveLength(1)

    // Mashing the button must not spend a request per click.
    const second = await adapter.forceRefresh()
    expect(fake.calls).toHaveLength(1)
    expect(second.skipped).toEqual(['item_1'])
    expect(second.refreshed).toEqual([])

    clock.advance(60 * 1000)
    await adapter.forceRefresh()
    expect(fake.calls).toHaveLength(2)
  })

  it('refuses once the rolling daily budget is spent, and says so', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = makeAdapter(clock, fake.fetch)

    // Spend the budget a minute at a time (the floor allows one per minute).
    for (let i = 0; i < 20; i++) {
      await adapter.forceRefresh()
      clock.advance(60 * 1000)
    }
    expect(fake.calls).toHaveLength(20)

    const blocked = await adapter.forceRefresh()
    expect(blocked.budgetExhausted).toBe(true)
    expect(blocked.refreshed).toEqual([])
    expect(fake.calls).toHaveLength(20) // no request spent past the cap

    // The budget is rolling, not a midnight reset.
    clock.advance(24 * HOUR)
    const later = await adapter.forceRefresh()
    expect(later.budgetExhausted).toBe(false)
    expect(fake.calls).toHaveLength(21)
  })

  it('reports a countdown that agrees with what the gate will actually do', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => JSON.parse(plainFixtureText) })
    const adapter = makeAdapter(clock, fake.fetch)

    await adapter.getAccounts('user_1')

    const status = adapter.getRefreshStatus()
    expect(status.msUntilRefreshAllowed).toBe(6 * HOUR)
    expect(status.requestsInLastDay).toBe(1)
    expect(status.forceRefreshBudgetRemaining).toBe(19)
    expect(status.inSetupGrace).toBe(false)

    clock.advance(6 * HOUR)
    expect(adapter.getRefreshStatus().msUntilRefreshAllowed).toBe(0)
  })

  it('propagates a rejected access URL rather than reporting a quiet success', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => new Response('', { status: 403 }) })
    const adapter = makeAdapter(clock, fake.fetch)

    await expect(adapter.forceRefresh()).rejects.toBeInstanceOf(ProviderAuthError)
  })

  it('reports a transient failure without throwing, leaving the cache intact', async () => {
    const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
    const fake = makeFakeFetch({ item1: () => new Response('', { status: 500 }) })
    const adapter = makeAdapter(clock, fake.fetch)

    const result = await adapter.forceRefresh()
    expect(result.refreshed).toEqual([])
    expect(result.error).toBeDefined()
    expect(result.error).not.toContain('sfin-p4ss')
  })
})
