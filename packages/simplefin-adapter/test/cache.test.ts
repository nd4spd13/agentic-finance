import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TokenStoreKeyError, type Account, type Transaction } from '@clad/core'
import { SimpleFinCache } from '../src/cache.js'

/** A mutable fake clock injected via `SimpleFinCacheOptions.now`. */
function makeFakeClock(startIso: string) {
  let current = new Date(startIso)
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
    set: (iso: string) => {
      current = new Date(iso)
    },
  }
}

const TEST_PASSPHRASE = 'cache-encryption-test-passphrase'

const HOUR = 60 * 60 * 1000

/**
 * Reaches past the public API to simulate a corrupted `fetch_log` row — the
 * "in doubt" case the fail-closed gate must handle without throwing, and
 * without treating an uncomputable age as permission to spend a request.
 */
function corruptFetchedAt(cache: SimpleFinCache, itemId: string): void {
  const db = (cache as unknown as { db: { exec: (sql: string) => void } }).db
  db.exec(`UPDATE fetch_log SET fetched_at = 'not-a-real-timestamp' WHERE item_id = '${itemId}'`)
}

describe('SimpleFinCache', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simplefin-cache-test-'))
    dbPath = join(dir, 'simplefin.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const account: Account = {
    id: 'simplefin:acct_1',
    name: 'SimpleFIN Checking',
    type: 'checking',
    mask: undefined,
    balance_current: 100,
    balance_available: 90,
    currency: 'USD',
  }

  const transaction: Transaction = {
    id: 'simplefin:acct_1:txn_1',
    account_id: 'simplefin:acct_1',
    amount: -20,
    date: '2026-01-05',
    description: 'Coffee',
    merchant_name: 'Cafe',
    category: undefined,
    pending: false,
  }

  describe('quota guardrail: shouldRefresh / getStaleness', () => {
    it('allows the very first fetch for an item that has never been fetched', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      expect(cache.shouldRefresh('item_1')).toBe(true)
      const staleness = cache.getStaleness('item_1')
      expect(staleness.lastFetchedAt).toBeUndefined()
      expect(staleness.stale).toBe(true)
      expect(staleness.ageMs).toBeUndefined()
      cache.close()
    })

    it('suppresses refresh immediately after a fetch (within the default 6h interval)', () => {
      const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now })

      cache.recordFetch('item_1', [account], [transaction])
      expect(cache.shouldRefresh('item_1')).toBe(false)

      clock.advance(HOUR) // 1h later, still well within the 6h default
      expect(cache.shouldRefresh('item_1')).toBe(false)

      cache.close()
    })

    it('allows refresh again once the default 6h interval has fully elapsed', () => {
      const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now })

      cache.recordFetch('item_1', [account], [transaction])
      clock.advance(6 * HOUR - 1)
      expect(cache.shouldRefresh('item_1')).toBe(false) // 1ms short of the interval

      clock.advance(1)
      expect(cache.shouldRefresh('item_1')).toBe(true) // exactly at the interval

      cache.close()
    })

    it('honors a configurable minRefreshIntervalMs', () => {
      const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: 1000 })

      cache.recordFetch('item_1', [account], [transaction])
      expect(cache.shouldRefresh('item_1')).toBe(false)

      clock.advance(999)
      expect(cache.shouldRefresh('item_1')).toBe(false)

      clock.advance(1)
      expect(cache.shouldRefresh('item_1')).toBe(true)

      cache.close()
    })

    it('tracks refresh eligibility independently per item', () => {
      const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: HOUR })

      cache.recordFetch('item_1', [account], [transaction])
      clock.advance(30 * 60 * 1000) // 30 min
      cache.recordFetch('item_2', [{ ...account, id: 'simplefin:acct_2' }], [])

      // item_1 was fetched 30min ago (of a 1h interval) -> still suppressed
      expect(cache.shouldRefresh('item_1')).toBe(false)
      // item_2 was just fetched -> also suppressed
      expect(cache.shouldRefresh('item_2')).toBe(false)

      clock.advance(31 * 60 * 1000) // total item_1 age: 61min > 60min interval
      expect(cache.shouldRefresh('item_1')).toBe(true)
      expect(cache.shouldRefresh('item_2')).toBe(false) // item_2 age: 31min < 60min

      cache.close()
    })

    it('reports msUntilRefreshAllowed counting down to zero', () => {
      const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: 1000 })

      expect(cache.msUntilRefreshAllowed('item_1')).toBe(0) // never fetched -> allowed now

      cache.recordFetch('item_1', [account], [transaction])
      expect(cache.msUntilRefreshAllowed('item_1')).toBe(1000)

      clock.advance(400)
      expect(cache.msUntilRefreshAllowed('item_1')).toBe(600)

      clock.advance(600)
      expect(cache.msUntilRefreshAllowed('item_1')).toBe(0)

      cache.close()
    })

    describe('fail-closed behavior', () => {
      // These two cases are where `shouldRefresh` and `getStaleness().stale`
      // deliberately disagree: an age we cannot compute is honestly *stale*
      // to display, but is never grounds to spend one of ~24 daily requests.
      // Both used to return `true` from shouldRefresh (they shared one
      // boolean), which meant a backwards clock produced an ungated fetch on
      // every single read.
      it('refuses to spend a request when the clock moved backwards, but still reports stale', () => {
        const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: HOUR })

        cache.recordFetch('item_1', [account], [transaction])
        // Clock jumps backwards (e.g. NTP correction) to before the recorded fetch.
        clock.set('2026-01-01T00:00:00.000Z')

        const staleness = cache.getStaleness('item_1')
        expect(staleness.ageMs).toBeLessThan(0)
        expect(staleness.stale).toBe(true)
        expect(cache.shouldRefresh('item_1')).toBe(false)

        cache.close()
      })

      it('refuses to spend a request on a corrupted stored timestamp rather than throwing', () => {
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
        cache.recordFetch('item_1', [account], [transaction])
        corruptFetchedAt(cache, 'item_1')

        const staleness = cache.getStaleness('item_1')
        expect(staleness.stale).toBe(true)
        expect(staleness.ageMs).toBeUndefined()
        expect(cache.shouldRefresh('item_1')).toBe(false)

        cache.close()
      })

      it('self-repairs an unreadable timestamp so the item resumes refreshing one interval later', () => {
        const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: HOUR })

        cache.recordFetch('item_1', [account], [transaction])
        corruptFetchedAt(cache, 'item_1')

        // First call refuses AND repairs, so the item is not frozen forever
        // behind a value that can never become parseable.
        expect(cache.shouldRefresh('item_1')).toBe(false)
        expect(cache.msUntilRefreshAllowed('item_1')).toBe(HOUR)

        clock.advance(HOUR - 1)
        expect(cache.shouldRefresh('item_1')).toBe(false)

        clock.advance(1)
        expect(cache.shouldRefresh('item_1')).toBe(true)

        cache.close()
      })

      it('does not charge the daily budget for a timestamp repair (no request was sent)', () => {
        const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: HOUR })

        cache.recordFetch('item_1', [account], [transaction])
        expect(cache.requestsInLastDay()).toBe(1)

        corruptFetchedAt(cache, 'item_1')
        cache.shouldRefresh('item_1') // triggers the repair

        expect(cache.requestsInLastDay()).toBe(1)

        cache.close()
      })

      it('never throws from shouldRefresh/getStaleness for an unknown item', () => {
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
        expect(() => cache.shouldRefresh('unknown_item')).not.toThrow()
        expect(() => cache.getStaleness('unknown_item')).not.toThrow()
        cache.close()
      })
    })

    describe('grace-window interval override', () => {
      it('allows a refresh under a shorter override that the default interval would still block', () => {
        const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: HOUR })

        cache.recordFetch('item_1', [account], [transaction])
        clock.advance(10 * 60 * 1000) // 10 minutes

        expect(cache.shouldRefresh('item_1')).toBe(false)
        expect(cache.shouldRefresh('item_1', { intervalMs: 5 * 60 * 1000 })).toBe(true)

        cache.close()
      })

      it('keeps msUntilRefreshAllowed consistent with the gate under an override', () => {
        const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: HOUR })

        cache.recordFetch('item_1', [account], [transaction])
        clock.advance(10 * 60 * 1000)

        const opts = { intervalMs: 30 * 60 * 1000 }
        expect(cache.msUntilRefreshAllowed('item_1', opts)).toBe(20 * 60 * 1000)
        expect(cache.shouldRefresh('item_1', opts)).toBe(false)

        clock.advance(20 * 60 * 1000)
        expect(cache.msUntilRefreshAllowed('item_1', opts)).toBe(0)
        expect(cache.shouldRefresh('item_1', opts)).toBe(true)

        cache.close()
      })

      it('still fails closed on an unreadable timestamp even with a zero override', () => {
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
        cache.recordFetch('item_1', [account], [transaction])
        corruptFetchedAt(cache, 'item_1')

        expect(cache.shouldRefresh('item_1', { intervalMs: 0 })).toBe(false)

        cache.close()
      })
    })

    describe('rolling 24h request budget', () => {
      it('counts one request per recordFetch across every item', () => {
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
        expect(cache.requestsInLastDay()).toBe(0)

        // Empty snapshots keep this focused on the request ledger without
        // colliding on accounts_cache's account_id primary key.
        cache.recordFetch('item_1', [], [])
        cache.recordFetch('item_2', [], [])
        cache.recordFetch('item_1', [], [])

        // fetch_log would report 2 here (one row per item, overwritten);
        // the budget must see all 3 real requests.
        expect(cache.requestsInLastDay()).toBe(3)

        cache.close()
      })

      it('drops requests out of the count once they age past 24h', () => {
        const clock = makeFakeClock('2026-01-05T00:00:00.000Z')
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now })

        cache.recordFetch('item_1', [account], [transaction])
        clock.advance(23 * HOUR)
        expect(cache.requestsInLastDay()).toBe(1)

        clock.advance(HOUR + 1)
        expect(cache.requestsInLastDay()).toBe(0)

        cache.close()
      })

      it('keeps a removed item\'s spent requests on the ledger', () => {
        const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
        cache.recordFetch('item_1', [account], [transaction])
        cache.recordFetch('item_1', [account], [transaction])

        cache.removeItem('item_1')

        // Those requests really were spent today; remove-then-re-add must not
        // become a way to zero the budget.
        expect(cache.requestsInLastDay()).toBe(2)
        expect(cache.getAccounts('item_1')).toEqual([])

        cache.close()
      })
    })
  })

  describe('serving cached data with staleness info', () => {
    it('marks served accounts/transactions stale once the refresh interval has elapsed', () => {
      const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: HOUR })

      cache.recordFetch('item_1', [account], [transaction])
      expect(cache.getAccounts('item_1')[0]?.stale).toBeUndefined()
      expect(cache.getTransactionsByItem('item_1')[0]?.stale).toBeUndefined()

      clock.advance(2 * HOUR)
      expect(cache.getAccounts('item_1')[0]?.stale).toBe(true)
      expect(cache.getTransactionsByItem('item_1')[0]?.stale).toBe(true)
      expect(cache.getTransactionsByAccount('simplefin:acct_1')[0]?.stale).toBe(true)
      expect(cache.getAccount('simplefin:acct_1')?.stale).toBe(true)
      expect(cache.getAllAccounts()[0]?.stale).toBe(true)

      cache.close()
    })

    it('still serves cached data (with staleness info) rather than returning nothing once past due', () => {
      const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now, minRefreshIntervalMs: HOUR })

      cache.recordFetch('item_1', [account], [transaction])
      clock.advance(100 * HOUR)

      const accounts = cache.getAccounts('item_1')
      expect(accounts).toHaveLength(1)
      expect(accounts[0]).toMatchObject({ id: 'simplefin:acct_1', stale: true })

      cache.close()
    })
  })

  describe('accounts_cache / transactions_cache storage', () => {
    it('upserts and reads back an account tagged with its item', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [account], [])
      const all = cache.getAllAccounts()
      expect(all).toHaveLength(1)
      expect(all[0]).toMatchObject({ ...account, itemId: 'item_1' })
      cache.close()
    })

    it('round-trips institution through the cache (SF5: the primary field for a resolved connection org name, distinct from subtype)', () => {
      // SimpleFIN's quota guardrail means most getAccounts() reads are
      // served from this cache rather than a live fetch (see shouldRefresh),
      // so institution must survive a cache round trip, not just live in the
      // freshly-mapped Account returned right after a fetch.
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [{ ...account, institution: 'Bank A Financial' }], [])
      const [cached] = cache.getAllAccounts()
      expect(cached?.institution).toBe('Bank A Financial')
      expect(cached?.subtype).toBeUndefined()
      cache.close()
    })

    it('scopes getAccounts / getTransactionsByItem to the requested item', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [account], [transaction])
      cache.recordFetch(
        'item_2',
        [{ ...account, id: 'simplefin:acct_2' }],
        [{ ...transaction, id: 'simplefin:acct_2:txn_2', account_id: 'simplefin:acct_2' }]
      )

      expect(cache.getAccounts('item_1').map((a) => a.id)).toEqual(['simplefin:acct_1'])
      expect(cache.getAccounts('item_2').map((a) => a.id)).toEqual(['simplefin:acct_2'])
      expect(cache.getTransactionsByItem('item_1').map((t) => t.id)).toEqual([
        'simplefin:acct_1:txn_1',
      ])
      expect(cache.getTransactionsByItem('item_2').map((t) => t.id)).toEqual([
        'simplefin:acct_2:txn_2',
      ])
      cache.close()
    })

    it('getAccount returns undefined for an uncached account', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      expect(cache.getAccount('simplefin:nope')).toBeUndefined()
      cache.close()
    })

    it('applies inclusive start_date/end_date filters and a count limit, sorted by date descending', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch(
        'item_1',
        [account],
        [
          { ...transaction, id: 'simplefin:acct_1:a', date: '2026-01-01' },
          { ...transaction, id: 'simplefin:acct_1:b', date: '2026-03-01' },
          { ...transaction, id: 'simplefin:acct_1:c', date: '2026-02-01' },
        ]
      )

      const filtered = cache.getTransactionsByAccount('simplefin:acct_1', {
        start_date: '2026-01-01',
        end_date: '2026-02-01',
      })
      expect(filtered.map((t) => t.id).sort()).toEqual(['simplefin:acct_1:a', 'simplefin:acct_1:c'])

      const limited = cache.getTransactionsByAccount('simplefin:acct_1', { count: 2 })
      expect(limited.map((t) => t.id)).toEqual(['simplefin:acct_1:b', 'simplefin:acct_1:c'])

      cache.close()
    })

    it('serializes and deserializes category arrays, leaving undefined when absent', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [account], [{ ...transaction, category: ['food_and_drink'] }])
      expect(cache.getTransactionsByItem('item_1')[0]?.category).toEqual(['food_and_drink'])

      cache.recordFetch('item_1', [account], [{ ...transaction, category: undefined }])
      expect(cache.getTransactionsByItem('item_1')[0]?.category).toBeUndefined()
      cache.close()
    })

    it('preserves undefined optional fields as undefined on read-back', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch(
        'item_1',
        [{ ...account, subtype: undefined, institution: undefined, mask: undefined, balance_available: undefined }],
        []
      )
      const [cached] = cache.getAllAccounts()
      expect(cached?.subtype).toBeUndefined()
      expect(cached?.institution).toBeUndefined()
      expect(cached?.mask).toBeUndefined()
      expect(cached?.balance_available).toBeUndefined()
      cache.close()
    })

    it('persists across reopening the same db file', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [account], [transaction])
      cache.close()

      const reopened = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      expect(reopened.getAllAccounts()).toHaveLength(1)
      expect(reopened.getStaleness('item_1').lastFetchedAt).toBeDefined()
      reopened.close()
    })
  })

  describe('full-refresh eviction semantics', () => {
    it('replaces (not merges) an item\'s accounts on the next recordFetch', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch(
        'item_1',
        [account, { ...account, id: 'simplefin:acct_2' }],
        []
      )
      expect(cache.getAccounts('item_1').map((a) => a.id)).toEqual([
        'simplefin:acct_1',
        'simplefin:acct_2',
      ])

      // acct_2 is gone from the live response (e.g. the account was closed).
      cache.recordFetch('item_1', [account], [])
      expect(cache.getAccounts('item_1').map((a) => a.id)).toEqual(['simplefin:acct_1'])
      cache.close()
    })

    it('replaces (not merges) an item\'s transactions on the next recordFetch', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [account], [transaction])
      expect(cache.getTransactionsByItem('item_1')).toHaveLength(1)

      // The live response no longer includes this transaction at all.
      cache.recordFetch('item_1', [account], [])
      expect(cache.getTransactionsByItem('item_1')).toHaveLength(0)
      cache.close()
    })

    it('does not disturb another item\'s cached data', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [account], [transaction])
      cache.recordFetch(
        'item_2',
        [{ ...account, id: 'simplefin:acct_2' }],
        [{ ...transaction, id: 'simplefin:acct_2:txn_2', account_id: 'simplefin:acct_2' }]
      )

      cache.recordFetch('item_1', [], [])
      expect(cache.getAccounts('item_1')).toHaveLength(0)
      expect(cache.getAccounts('item_2')).toHaveLength(1)
      expect(cache.getTransactionsByItem('item_2')).toHaveLength(1)
      cache.close()
    })

    it('updates an existing account in place when its id is unchanged across fetches', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [account], [])
      cache.recordFetch('item_1', [{ ...account, balance_current: 500 }], [])
      const all = cache.getAllAccounts()
      expect(all).toHaveLength(1)
      expect(all[0]?.balance_current).toBe(500)
      cache.close()
    })
  })

  describe('removeItem', () => {
    it('purges an item\'s accounts, transactions, and fetch-log entry', () => {
      const clock = makeFakeClock('2026-01-01T00:00:00.000Z')
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE, now: clock.now })
      cache.recordFetch('item_1', [account], [transaction])
      expect(cache.getAccounts('item_1')).toHaveLength(1)
      expect(cache.getStaleness('item_1').lastFetchedAt).toBeDefined()

      cache.removeItem('item_1')

      expect(cache.getAccounts('item_1')).toHaveLength(0)
      expect(cache.getTransactionsByItem('item_1')).toHaveLength(0)
      // fetch_log entry gone → back to the "never fetched" state.
      expect(cache.getStaleness('item_1').lastFetchedAt).toBeUndefined()
      expect(cache.shouldRefresh('item_1')).toBe(true)
      cache.close()
    })

    it('leaves another item\'s cached data untouched', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [account], [transaction])
      cache.recordFetch(
        'item_2',
        [{ ...account, id: 'simplefin:acct_2' }],
        [{ ...transaction, id: 'simplefin:acct_2:txn_2', account_id: 'simplefin:acct_2' }]
      )

      cache.removeItem('item_1')

      expect(cache.getAccounts('item_1')).toHaveLength(0)
      expect(cache.getAccounts('item_2')).toHaveLength(1)
      expect(cache.getTransactionsByItem('item_2')).toHaveLength(1)
      expect(cache.getStaleness('item_2').lastFetchedAt).toBeDefined()
      cache.close()
    })

    it('is a no-op for an item that has nothing cached', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      expect(() => cache.removeItem('never-existed')).not.toThrow()
      cache.close()
    })
  })

  describe('encryption at rest (D5.1)', () => {
    const MARKER = 'ZZZ_SECRET_MERCHANT_ZZZ'

    it('never writes financial data in cleartext to the DB or the raw file', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch(
        'item_1',
        [{ ...account, name: MARKER }],
        [{ ...transaction, description: MARKER, merchant_name: MARKER }]
      )
      cache.close()

      // (a) Open the file raw and confirm no plaintext column in the cache
      // tables carries the marker.
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
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch(
        'item_1',
        [{ ...account, name: MARKER }],
        [{ ...transaction, description: MARKER, merchant_name: MARKER }]
      )
      expect(cache.getAllAccounts()[0].name).toBe(MARKER)
      const [txn] = cache.getTransactionsByAccount('simplefin:acct_1')
      expect(txn.description).toBe(MARKER)
      expect(txn.merchant_name).toBe(MARKER)
      cache.close()
    })

    it('throws TokenStoreKeyError when reopened with the wrong passphrase', () => {
      const cache = new SimpleFinCache({ dbPath, passphrase: TEST_PASSPHRASE })
      cache.recordFetch('item_1', [account], [transaction])
      cache.close()

      expect(
        () => new SimpleFinCache({ dbPath, passphrase: 'a different passphrase' })
      ).toThrow(TokenStoreKeyError)
    })
  })

  describe('migration from the pre-D5.1 plaintext schema', () => {
    const MARKER = 'ZZZ_SECRET_MERCHANT_ZZZ'

    it('drops plaintext cache tables + VACUUMs, but PRESERVES fetch_history', () => {
      const legacyDbPath = join(dir, 'legacy-simplefin.sqlite')
      const legacyDb = new DatabaseSync(legacyDbPath)
      // Old plaintext financial-data tables.
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
          currency TEXT NOT NULL
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
          pending INTEGER NOT NULL
        )
      `)
      // Quota ledger that must survive migration.
      legacyDb.exec(`
        CREATE TABLE fetch_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        )
      `)
      legacyDb
        .prepare(
          `INSERT INTO accounts_cache (
            account_id, item_id, name, type, subtype, institution, mask,
            balance_current, balance_available, currency
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('simplefin:acct_legacy', 'item_1', MARKER, 'checking', null, null, null, 100, null, 'USD')
      // A recent spent request in the rolling 24h window.
      legacyDb
        .prepare('INSERT INTO fetch_history (item_id, fetched_at) VALUES (?, ?)')
        .run('item_1', new Date().toISOString())
      legacyDb.close()

      expect(readFileSync(legacyDbPath).includes(Buffer.from(MARKER, 'utf8'))).toBe(true)

      const migrated = new SimpleFinCache({ dbPath: legacyDbPath, passphrase: TEST_PASSPHRASE })
      // (a) Old financial rows are gone — re-fetchable by design.
      expect(migrated.getAllAccounts()).toHaveLength(0)
      // (c) The pre-existing fetch_history row is preserved (the ledger survives).
      expect(migrated.requestsInLastDay()).toBe(1)
      migrated.close()

      // (b) VACUUM scrubbed the marker from the raw file.
      expect(readFileSync(legacyDbPath).includes(Buffer.from(MARKER, 'utf8'))).toBe(false)
    })
  })
})
