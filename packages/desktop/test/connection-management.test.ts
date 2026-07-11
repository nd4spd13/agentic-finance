/**
 * Connection management (list + remove linked items) tests.
 *
 * Mirrors the DI/no-network conventions of `simplefin-connect.test.ts` and
 * `plaid-link-flow.test.ts`: the token stores and caches are the real
 * `@clad/core` / `@clad/plaid-adapter` / `@clad/simplefin-adapter` classes
 * writing to a throwaway temp SQLite file, but Plaid's `/item/remove` is
 * always an injected fake `PlaidClientLike` — no test here touches a real
 * network.
 *
 * Security assertions run throughout: the stored Plaid access token / SimpleFIN
 * access URL must never appear in any `LinkedItem`, warning, or error string
 * that crosses back toward the renderer.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteTokenStore } from '@clad/core'
import { PlaidCache } from '@clad/plaid-adapter'
import { SimpleFinCache } from '@clad/simplefin-adapter'
import {
  listPlaidItems,
  removePlaidItem,
  listSimpleFinItems,
  removeSimpleFinItem,
} from '../src/main/lib/connection-management.js'
import type { CladConfig } from '../src/main/lib/config.js'

const PASSPHRASE = 'unit-test-passphrase'
const PLAID_ACCESS_TOKEN = 'access-sandbox-11112222-3333-4444-5555-666677778888'
const SIMPLEFIN_ACCESS_URL = 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/abc123'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function makeConfig(overrides: Partial<CladConfig> = {}): CladConfig {
  const base = dir ?? (dir = mkdtempSync(join(tmpdir(), 'clad-desktop-conn-mgmt-test-')))
  return {
    policy_path: join(base, 'policy.yaml'),
    audit_db: join(base, 'audit.sqlite'),
    approval_db: join(base, 'approvals.sqlite'),
    server_pid_file: join(base, 'server.pid'),
    provider: 'plaid',
    plaid_db: join(base, 'plaid.sqlite'),
    plaid_env: 'sandbox',
    close_to_tray: true,
    simplefin_db: join(base, 'simplefin.sqlite'),
    ...overrides,
  }
}

/** Seeds a Plaid token + cache rows for one item at the config's plaid_db. */
function seedPlaidItem(config: CladConfig, itemId: string, institution: string): void {
  const store = new SqliteTokenStore({ dbPath: config.plaid_db, passphrase: PASSPHRASE })
  store.saveItem({ itemId, institutionName: institution, accessToken: PLAID_ACCESS_TOKEN })
  store.close()
  const cache = new PlaidCache(config.plaid_db)
  cache.upsertAccounts(itemId, [
    {
      id: `${itemId}-acc`,
      name: 'Checking',
      type: 'checking',
      balance_current: 100,
      currency: 'USD',
    },
  ])
  cache.upsertTransactions(itemId, [
    {
      id: `${itemId}-txn`,
      account_id: `${itemId}-acc`,
      amount: -5,
      date: '2026-01-05',
      description: 'Coffee',
      pending: false,
    },
  ])
  cache.saveCursor(itemId, 'cursor_1')
  cache.close()
}

function seedSimpleFinItem(config: CladConfig, itemId: string): void {
  const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
  store.saveItem({ itemId, institutionName: 'SimpleFIN Bridge', accessToken: SIMPLEFIN_ACCESS_URL })
  store.close()
  const cache = new SimpleFinCache({ dbPath: config.simplefin_db })
  cache.recordFetch(
    itemId,
    [{ id: `${itemId}-acc`, name: 'Savings', type: 'savings', balance_current: 50, currency: 'USD' }],
    []
  )
  cache.close()
}

/** A fake Plaid client that records the access token passed to `/item/remove`. */
function makeFakeClient(options: { onItemRemove?: (accessToken: string) => void; fail?: Error } = {}) {
  return {
    itemRemove: async (request: { access_token: string }) => {
      options.onItemRemove?.(request.access_token)
      if (options.fail) throw options.fail
      return { data: { request_id: 'req_remove' } }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function assertNoSecret(haystack: string | undefined): void {
  if (haystack === undefined) return
  expect(haystack).not.toContain(PLAID_ACCESS_TOKEN)
  expect(haystack).not.toContain(SIMPLEFIN_ACCESS_URL)
  expect(haystack).not.toContain('sfin-p4ss')
}

// ---- Plaid: listing --------------------------------------------------------

describe('listPlaidItems', () => {
  it('returns [] when the passphrase is not resolved yet, without needing a store', async () => {
    const items = await listPlaidItems({ loadConfig: () => makeConfig(), getActivePassphrase: () => null })
    expect(items).toEqual([])
  })

  it('returns display-safe metadata for each stored item, never a token', async () => {
    const config = makeConfig()
    seedPlaidItem(config, 'item_1', 'First Bank')
    seedPlaidItem(config, 'item_2', 'Second Bank')

    const items = await listPlaidItems({ loadConfig: () => config, getActivePassphrase: () => PASSPHRASE })

    expect(items.map((i) => i.itemId).sort()).toEqual(['item_1', 'item_2'])
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'institutionName', 'itemId'])
      expect(typeof item.createdAt).toBe('string')
    }
    assertNoSecret(JSON.stringify(items))
  })
})

// ---- Plaid: removal --------------------------------------------------------

describe('removePlaidItem', () => {
  it('errors (without deleting) when the passphrase is not resolved', async () => {
    const config = makeConfig()
    const result = await removePlaidItem('item_1', {
      loadConfig: () => config,
      getActivePassphrase: () => null,
      loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/passphrase/i)
  })

  it('revokes upstream, then deletes the token and purges cache rows', async () => {
    const config = makeConfig()
    seedPlaidItem(config, 'item_1', 'First Bank')
    let revokedToken: string | undefined

    const result = await removePlaidItem('item_1', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
      createClient: () => makeFakeClient({ onItemRemove: (t) => (revokedToken = t) }),
    })

    expect(result.ok).toBe(true)
    expect(result.warning).toBeUndefined()
    // Best-effort revocation used the real stored token (in-process only).
    expect(revokedToken).toBe(PLAID_ACCESS_TOKEN)

    // Token gone.
    const store = new SqliteTokenStore({ dbPath: config.plaid_db, passphrase: PASSPHRASE })
    expect(store.listItems()).toHaveLength(0)
    store.close()
    // Cache rows gone.
    const cache = new PlaidCache(config.plaid_db)
    expect(cache.getAccountsByItem('item_1')).toHaveLength(0)
    expect(cache.getTransactionsByItem('item_1')).toHaveLength(0)
    expect(cache.getCursor('item_1')).toBeUndefined()
    cache.close()
  })

  it('still deletes locally (with a warning) when upstream revocation fails, leaking no token', async () => {
    const config = makeConfig()
    seedPlaidItem(config, 'item_1', 'First Bank')

    const result = await removePlaidItem('item_1', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
      createClient: () => makeFakeClient({ fail: new Error('Request failed with status code 400') }),
    })

    expect(result.ok).toBe(true)
    expect(result.warning).toMatch(/revok/i)
    assertNoSecret(result.warning)
    assertNoSecret(result.error)

    const store = new SqliteTokenStore({ dbPath: config.plaid_db, passphrase: PASSPHRASE })
    expect(store.listItems()).toHaveLength(0)
    store.close()
  })

  it('warns (but still deletes) when no credentials are available to revoke', async () => {
    const config = makeConfig()
    seedPlaidItem(config, 'item_1', 'First Bank')

    const result = await removePlaidItem('item_1', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      loadPlaidCredentials: () => null,
    })

    expect(result.ok).toBe(true)
    expect(result.warning).toMatch(/credentials are not available/i)

    const store = new SqliteTokenStore({ dbPath: config.plaid_db, passphrase: PASSPHRASE })
    expect(store.listItems()).toHaveLength(0)
    store.close()
  })

  it('leaves other items untouched when removing one', async () => {
    const config = makeConfig()
    seedPlaidItem(config, 'item_1', 'First Bank')
    seedPlaidItem(config, 'item_2', 'Second Bank')

    const result = await removePlaidItem('item_1', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
      createClient: () => makeFakeClient(),
    })
    expect(result.ok).toBe(true)

    const items = await listPlaidItems({ loadConfig: () => config, getActivePassphrase: () => PASSPHRASE })
    expect(items.map((i) => i.itemId)).toEqual(['item_2'])
    const cache = new PlaidCache(config.plaid_db)
    expect(cache.getAccountsByItem('item_2')).toHaveLength(1)
    cache.close()
  })

  it('succeeds without attempting revocation for an item that no longer exists', async () => {
    const config = makeConfig()
    seedPlaidItem(config, 'item_1', 'First Bank')
    let revokeAttempted = false

    const result = await removePlaidItem('does-not-exist', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
      createClient: () => makeFakeClient({ onItemRemove: () => (revokeAttempted = true) }),
    })

    expect(result.ok).toBe(true)
    expect(revokeAttempted).toBe(false)
    // The existing item is untouched.
    const store = new SqliteTokenStore({ dbPath: config.plaid_db, passphrase: PASSPHRASE })
    expect(store.listItems().map((i) => i.itemId)).toEqual(['item_1'])
    store.close()
  })
})

// ---- SimpleFIN: listing + removal -----------------------------------------

describe('listSimpleFinItems', () => {
  it('returns [] when the passphrase is not resolved yet', async () => {
    const items = await listSimpleFinItems({ loadConfig: () => makeConfig(), getActivePassphrase: () => null })
    expect(items).toEqual([])
  })

  it('lists stored SimpleFIN items with no access URL', async () => {
    const config = makeConfig()
    seedSimpleFinItem(config, 'sf_1')
    const items = await listSimpleFinItems({ loadConfig: () => config, getActivePassphrase: () => PASSPHRASE })
    expect(items).toHaveLength(1)
    expect(items[0]?.institutionName).toBe('SimpleFIN Bridge')
    assertNoSecret(JSON.stringify(items))
  })
})

describe('removeSimpleFinItem', () => {
  it('errors when the passphrase is not resolved', async () => {
    const config = makeConfig()
    const result = await removeSimpleFinItem('sf_1', {
      loadConfig: () => config,
      getActivePassphrase: () => null,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/passphrase/i)
  })

  it('deletes the token and purges cache rows locally (no revoke API)', async () => {
    const config = makeConfig()
    seedSimpleFinItem(config, 'sf_1')

    const result = await removeSimpleFinItem('sf_1', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
    })

    expect(result.ok).toBe(true)
    assertNoSecret(result.warning)
    assertNoSecret(result.error)

    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
    expect(store.listItems()).toHaveLength(0)
    store.close()
    const cache = new SimpleFinCache({ dbPath: config.simplefin_db })
    expect(cache.getAccounts('sf_1')).toHaveLength(0)
    expect(cache.getStaleness('sf_1').lastFetchedAt).toBeUndefined()
    cache.close()
  })

  it('does not touch the Plaid store when removing a SimpleFIN item', async () => {
    const config = makeConfig()
    seedPlaidItem(config, 'item_1', 'First Bank')
    seedSimpleFinItem(config, 'sf_1')

    await removeSimpleFinItem('sf_1', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
    })

    expect(existsSync(config.plaid_db)).toBe(true)
    const store = new SqliteTokenStore({ dbPath: config.plaid_db, passphrase: PASSPHRASE })
    expect(store.listItems().map((i) => i.itemId)).toEqual(['item_1'])
    store.close()
  })
})
