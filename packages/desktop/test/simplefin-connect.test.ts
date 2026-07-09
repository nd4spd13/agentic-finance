/**
 * D3.2 SimpleFIN paste-a-token connect flow tests.
 *
 * Mirrors the coverage shape of `packages/cli/test/connect.test.ts`'s
 * SimpleFIN block. No test here touches the network: every SimpleFIN call
 * goes through an injected fake `fetch`, matching the convention
 * `@clad/simplefin-adapter`'s and `@clad/cli`'s own test suites use.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteTokenStore } from '@clad/core'
import {
  claimAndStoreSimpleFinToken,
  getSimpleFinConnectionState,
} from '../src/main/lib/simplefin-connect.js'
import type { CladConfig } from '../src/main/lib/config.js'

const FAKE_ACCESS_URL = 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/abc123'
const FAKE_USERINFO = 'sfin-user:sfin-p4ss'
const FAKE_CLAIM_URL = 'https://bridge.example.org/simplefin/claim/one-time-token-xyz'

function encodeSetupToken(url: string): string {
  return Buffer.from(url, 'utf-8').toString('base64')
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200, statusText: 'OK' })
}

function errorResponse(status: number, statusText: string, body = ''): Response {
  return new Response(body, { status, statusText })
}

function fakeAccountSetBody(): string {
  return JSON.stringify({
    errlist: [],
    accounts: [
      {
        id: 'acct-0001-abcdefg1234',
        name: 'Everyday Checking',
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

function makeFakeFetch(factories: Array<() => Response | Promise<Response>>): {
  fetch: typeof fetch
  callCount: () => number
} {
  let count = 0
  const fetchImpl = (async () => {
    const factory = factories[Math.min(count, factories.length - 1)]
    count += 1
    return factory()
  }) as typeof fetch
  return { fetch: fetchImpl, callCount: () => count }
}

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function makeConfig(overrides: Partial<CladConfig> = {}): CladConfig {
  const base = dir ?? (dir = mkdtempSync(join(tmpdir(), 'clad-desktop-simplefin-connect-test-')))
  return {
    policy_path: join(base, 'policy.yaml'),
    audit_db: join(base, 'audit.sqlite'),
    approval_db: join(base, 'approvals.sqlite'),
    server_pid_file: join(base, 'server.pid'),
    provider: 'dummy',
    plaid_db: join(base, 'plaid.sqlite'),
    plaid_env: 'sandbox',
    close_to_tray: true,
    simplefin_db: join(base, 'simplefin.sqlite'),
    ...overrides,
  }
}

function assertNoAccessUrl(haystack: string): void {
  expect(haystack).not.toContain(FAKE_ACCESS_URL)
  expect(haystack).not.toContain(FAKE_USERINFO)
}

describe('claimAndStoreSimpleFinToken', () => {
  it('rejects an empty setup token without touching the network or the passphrase', async () => {
    const { fetch, callCount } = makeFakeFetch([() => okResponse(FAKE_ACCESS_URL)])
    const result = await claimAndStoreSimpleFinToken('   ', {
      loadConfig: () => makeConfig(),
      getActivePassphrase: () => 'unit-test-passphrase',
      fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/setup token is required/i)
    expect(callCount()).toBe(0)
  })

  it('reports when the token-store passphrase is not resolved yet, without touching the network', async () => {
    const { fetch, callCount } = makeFakeFetch([() => okResponse(FAKE_ACCESS_URL)])
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const result = await claimAndStoreSimpleFinToken(token, {
      loadConfig: () => makeConfig(),
      getActivePassphrase: () => null,
      fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/passphrase/i)
    expect(callCount()).toBe(0)
  })

  it('reports a malformed (non-base64) setup token and stores nothing', async () => {
    const config = makeConfig()
    const { fetch, callCount } = makeFakeFetch([() => okResponse(FAKE_ACCESS_URL)])

    const result = await claimAndStoreSimpleFinToken('not-valid-base64!!! not a token', {
      loadConfig: () => config,
      getActivePassphrase: () => 'unit-test-passphrase',
      fetch,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not valid base64/i)
    expect(callCount()).toBe(0)

    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'unit-test-passphrase' })
    try {
      expect(store.listItems()).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('reports a reused/rejected setup token (non-2xx claim response) and stores nothing', async () => {
    const config = makeConfig()
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([() => errorResponse(403, 'Forbidden')])

    const result = await claimAndStoreSimpleFinToken(token, {
      loadConfig: () => config,
      getActivePassphrase: () => 'unit-test-passphrase',
      fetch,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/one-time use/i)

    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'unit-test-passphrase' })
    try {
      expect(store.listItems()).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('persists the item (with a simplefin-prefixed itemId) even when the follow-up account fetch fails', async () => {
    const config = makeConfig()
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([
      () => okResponse(FAKE_ACCESS_URL),
      () => errorResponse(500, 'Internal Server Error'),
    ])

    const result = await claimAndStoreSimpleFinToken(token, {
      loadConfig: () => config,
      getActivePassphrase: () => 'unit-test-passphrase',
      fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.itemId).toMatch(/^simplefin-/)
    expect(result.warning).toMatch(/could not fetch an initial account summary yet/i)
    expect(result.warning).toMatch(/credentials were saved/i)

    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'unit-test-passphrase' })
    try {
      const items = store.listItems()
      expect(items).toHaveLength(1)
      expect(items[0].itemId).toBe(result.itemId)
      expect(items[0].institutionName).toBe('SimpleFIN Bridge')
      expect(store.getAccessToken(items[0].itemId)).toBe(FAKE_ACCESS_URL)
    } finally {
      store.close()
    }

    assertNoAccessUrl(JSON.stringify(result))
  })

  it('claims, stores, and returns a display-safe account summary — never the raw access URL', async () => {
    const config = makeConfig()
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([() => okResponse(FAKE_ACCESS_URL), () => okResponse(fakeAccountSetBody())])

    const result = await claimAndStoreSimpleFinToken(token, {
      loadConfig: () => config,
      getActivePassphrase: () => 'unit-test-passphrase',
      fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.warning).toBeUndefined()
    expect(result.accounts).toEqual([
      { id: 'simplefin:acct-0001-abcdefg1234', name: 'Everyday Checking', institution: 'Test Bank Financial' },
    ])
    assertNoAccessUrl(JSON.stringify(result))

    const state = await getSimpleFinConnectionState({
      loadConfig: () => config,
      getActivePassphrase: () => 'unit-test-passphrase',
    })
    expect(state).toBe('connected')
  })
})

describe('getSimpleFinConnectionState', () => {
  it('is "unavailable" when the passphrase is not resolved', async () => {
    const state = await getSimpleFinConnectionState({
      loadConfig: () => makeConfig(),
      getActivePassphrase: () => null,
    })
    expect(state).toBe('unavailable')
  })

  it('is "not-connected" when the passphrase resolves but nothing has been saved yet', async () => {
    const state = await getSimpleFinConnectionState({
      loadConfig: () => makeConfig(),
      getActivePassphrase: () => 'unit-test-passphrase',
    })
    expect(state).toBe('not-connected')
  })
})
