/**
 * Tests for the desktop "Check for new accounts" path (`simplefin-refresh.ts`).
 *
 * Same DI/no-network conventions as `simplefin-connect.test.ts`: a real
 * `@clad/core` `SqliteTokenStore` + real `@clad/simplefin-adapter`
 * `SimpleFinCache` writing to a throwaway temp SQLite file, with an injected
 * fake `fetch` — no test here touches the network. The security invariant is
 * asserted throughout: the stored access URL must never surface in any
 * result/error crossing back toward the renderer.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteTokenStore } from '@clad/core'
import {
  forceRefreshSimpleFin,
  getSimpleFinRefreshStatus,
} from '../src/main/lib/simplefin-refresh.js'
import type { CladConfig } from '../src/main/lib/config.js'

const PASSPHRASE = 'unit-test-passphrase'
const FAKE_ACCESS_URL = 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/abc123'
const FAKE_USERINFO = 'sfin-user:sfin-p4ss'

function fakeAccountSetBody(accountName = 'Everyday Checking'): string {
  return JSON.stringify({
    errlist: [],
    accounts: [
      {
        id: 'acct-0001-abcdefg1234',
        name: accountName,
        currency: 'USD',
        balance: '532.10',
        'available-balance': '500.00',
        'balance-date': 1783555200,
        transactions: [],
        holdings: [],
        conn_id: 'conn-1',
      },
    ],
    connections: [
      {
        conn_id: 'conn-1',
        name: 'Test Bank',
        org_id: 'org-1',
        org_name: 'Test Bank Financial',
        org_url: 'https://testbank.example',
        sfin_url: 'https://bridge.example.org/simplefin',
      },
    ],
  })
}

/** Fake `fetch` that counts calls and returns a fresh 200 account-set each time. */
function makeFakeFetch(bodyFor: (n: number) => Response = () => new Response(fakeAccountSetBody(), { status: 200 })): {
  fetch: typeof fetch
  callCount: () => number
} {
  let count = 0
  const fetchImpl = (async () => {
    const res = bodyFor(count)
    count += 1
    return res
  }) as typeof fetch
  return { fetch: fetchImpl, callCount: () => count }
}

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function makeConfig(overrides: Partial<CladConfig> = {}): CladConfig {
  const base = dir ?? (dir = mkdtempSync(join(tmpdir(), 'clad-desktop-simplefin-refresh-test-')))
  return {
    policy_path: join(base, 'policy.yaml'),
    audit_db: join(base, 'audit.sqlite'),
    approval_db: join(base, 'approvals.sqlite'),
    server_pid_file: join(base, 'server.pid'),
    provider: 'simplefin',
    plaid_db: join(base, 'plaid.sqlite'),
    plaid_env: 'sandbox',
    close_to_tray: true,
    simplefin_db: join(base, 'simplefin.sqlite'),
    ...overrides,
  }
}

/** Seeds one SimpleFIN item (access URL) into the config's token store. */
function seedSimpleFinItem(config: CladConfig, itemId = 'simplefin-item-1'): void {
  const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
  store.saveItem({ itemId, institutionName: 'SimpleFIN Bridge', accessToken: FAKE_ACCESS_URL })
  store.close()
}

function assertNoAccessUrl(haystack: string): void {
  expect(haystack).not.toContain(FAKE_ACCESS_URL)
  expect(haystack).not.toContain(FAKE_USERINFO)
}

describe('forceRefreshSimpleFin', () => {
  it('refuses without touching the network when the passphrase is unresolved', async () => {
    const { fetch, callCount } = makeFakeFetch()
    const config = makeConfig()
    seedSimpleFinItem(config)

    const result = await forceRefreshSimpleFin({
      loadConfig: () => config,
      getActivePassphrase: () => null,
      fetch,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/passphrase is not resolved/i)
    expect(callCount()).toBe(0)
  })

  it('makes a live fetch and reports it against the daily budget', async () => {
    const { fetch, callCount } = makeFakeFetch()
    const config = makeConfig()
    seedSimpleFinItem(config)

    const result = await forceRefreshSimpleFin({
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.refreshedCount).toBe(1)
    expect(result.skippedCount).toBe(0)
    expect(result.budgetExhausted).toBe(false)
    expect(result.requestsInLastDay).toBe(1)
    expect(callCount()).toBe(1)
  })

  it('skips (no second request) when clicked again within the one-minute floor', async () => {
    const { fetch, callCount } = makeFakeFetch()
    const config = makeConfig()
    seedSimpleFinItem(config)
    const deps = { loadConfig: () => config, getActivePassphrase: () => PASSPHRASE, fetch }

    await forceRefreshSimpleFin(deps)
    const second = await forceRefreshSimpleFin(deps)

    expect(second.ok).toBe(true)
    expect(second.refreshedCount).toBe(0)
    expect(second.skippedCount).toBe(1)
    expect(callCount()).toBe(1) // no second network call
  })

  it('reports ok with no items when nothing is linked', async () => {
    const { fetch, callCount } = makeFakeFetch()
    const config = makeConfig()

    const result = await forceRefreshSimpleFin({
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.refreshedCount).toBe(0)
    expect(callCount()).toBe(0)
  })

  it('never leaks the access URL in a fetch-failure error', async () => {
    const { fetch } = makeFakeFetch(() => new Response('', { status: 500 }))
    const config = makeConfig()
    seedSimpleFinItem(config)

    const result = await forceRefreshSimpleFin({
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      fetch,
    })

    // A 500 is transient: reported via `error`, not thrown, cache left intact.
    expect(result.error).toBeDefined()
    assertNoAccessUrl(result.error ?? '')
  })

  it('surfaces a rejected access URL (HTTP 403) as a display-safe re-link error', async () => {
    const { fetch } = makeFakeFetch(() => new Response('', { status: 403 }))
    const config = makeConfig()
    seedSimpleFinItem(config)

    const result = await forceRefreshSimpleFin({
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      fetch,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/re-link/i)
    assertNoAccessUrl(result.error ?? '')
  })
})

describe('getSimpleFinRefreshStatus', () => {
  it('reports unavailable when the passphrase is unresolved', async () => {
    const config = makeConfig()
    const status = await getSimpleFinRefreshStatus({
      loadConfig: () => config,
      getActivePassphrase: () => null,
    })
    expect(status.available).toBe(false)
  })

  it('reports a countdown and spent budget after a fetch, without a new request', async () => {
    const { fetch, callCount } = makeFakeFetch()
    const config = makeConfig()
    seedSimpleFinItem(config)
    await forceRefreshSimpleFin({ loadConfig: () => config, getActivePassphrase: () => PASSPHRASE, fetch })

    const status = await getSimpleFinRefreshStatus({
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
    })

    expect(status.available).toBe(true)
    expect(status.requestsInLastDay).toBe(1)
    // Just fetched, so the next automatic (6h) refresh is some way off.
    expect(status.msUntilRefreshAllowed).toBeGreaterThan(0)
    expect(callCount()).toBe(1) // status read spent no request
  })
})
