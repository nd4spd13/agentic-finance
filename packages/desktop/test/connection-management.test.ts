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
import { effectivePlaidDbPath, type CladConfig } from '../src/main/lib/config.js'

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

/** The env-scoped path `listPlaidItems`/`removePlaidItem` actually open for `config` — see `effectivePlaidDbPath`. */
function activePlaidDbPath(config: CladConfig): string {
  return effectivePlaidDbPath(config, config.plaid_env)
}

/** Seeds a Plaid token + cache rows for one item at the config's ACTIVE (env-scoped) Plaid db path. */
function seedPlaidItem(config: CladConfig, itemId: string, institution: string): void {
  const store = new SqliteTokenStore({ dbPath: activePlaidDbPath(config), passphrase: PASSPHRASE })
  store.saveItem({ itemId, institutionName: institution, accessToken: PLAID_ACCESS_TOKEN })
  store.close()
  const cache = new PlaidCache({ dbPath: activePlaidDbPath(config), passphrase: PASSPHRASE })
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
  const cache = new SimpleFinCache({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
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
    const store = new SqliteTokenStore({ dbPath: activePlaidDbPath(config), passphrase: PASSPHRASE })
    expect(store.listItems()).toHaveLength(0)
    store.close()
    // Cache rows gone.
    const cache = new PlaidCache({ dbPath: activePlaidDbPath(config), passphrase: PASSPHRASE })
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

    const store = new SqliteTokenStore({ dbPath: activePlaidDbPath(config), passphrase: PASSPHRASE })
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

    const store = new SqliteTokenStore({ dbPath: activePlaidDbPath(config), passphrase: PASSPHRASE })
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
    const cache = new PlaidCache({ dbPath: activePlaidDbPath(config), passphrase: PASSPHRASE })
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
    const store = new SqliteTokenStore({ dbPath: activePlaidDbPath(config), passphrase: PASSPHRASE })
    expect(store.listItems().map((i) => i.itemId)).toEqual(['item_1'])
    store.close()
  })
})

// ---- Plaid: env-scoping (D3.3) ---------------------------------------------
//
// Mirrors `test/provider-factory.test.ts`'s D3.3 coverage: sandbox and
// production share the same `config.plaid_db` field but resolve to different
// physical SQLite files via `effectivePlaidDbPath`, so list/remove must never
// cross the env boundary.

describe('Plaid env-scoping (D3.3)', () => {
  it('sandbox list/remove touches the derived -sandbox file, never config.plaid_db', async () => {
    const config = makeConfig({ plaid_env: 'sandbox' })
    seedPlaidItem(config, 'item_sandbox', 'Sandbox Bank')

    // Seeding (via the module's own env-scoped path) never created the raw
    // plaid_db file — only the derived -sandbox sibling exists.
    expect(existsSync(config.plaid_db)).toBe(false)
    expect(existsSync(effectivePlaidDbPath(config, 'sandbox'))).toBe(true)

    const items = await listPlaidItems({ loadConfig: () => config, getActivePassphrase: () => PASSPHRASE })
    expect(items.map((i) => i.itemId)).toEqual(['item_sandbox'])

    const result = await removePlaidItem('item_sandbox', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      loadPlaidCredentials: () => null,
    })
    expect(result.ok).toBe(true)

    // Still never touched the raw plaid_db path.
    expect(existsSync(config.plaid_db)).toBe(false)
    const sandboxStore = new SqliteTokenStore({
      dbPath: effectivePlaidDbPath(config, 'sandbox'),
      passphrase: PASSPHRASE,
    })
    expect(sandboxStore.listItems()).toHaveLength(0)
    sandboxStore.close()
  })

  it('production list/remove touches config.plaid_db verbatim (CLI interop)', async () => {
    const config = makeConfig({ plaid_env: 'production' })
    seedPlaidItem(config, 'item_prod', 'Prod Bank')

    expect(effectivePlaidDbPath(config, 'production')).toBe(config.plaid_db)
    expect(existsSync(config.plaid_db)).toBe(true)

    const items = await listPlaidItems({ loadConfig: () => config, getActivePassphrase: () => PASSPHRASE })
    expect(items.map((i) => i.itemId)).toEqual(['item_prod'])

    const result = await removePlaidItem('item_prod', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      loadPlaidCredentials: () => null,
    })
    expect(result.ok).toBe(true)

    const store = new SqliteTokenStore({ dbPath: config.plaid_db, passphrase: PASSPHRASE })
    expect(store.listItems()).toHaveLength(0)
    store.close()
  })

  it('sandbox and production items are invisible to each other despite sharing the same plaid_db field', async () => {
    const sandboxConfig = makeConfig({ plaid_env: 'sandbox' })
    const productionConfig = { ...sandboxConfig, plaid_env: 'production' as const }

    seedPlaidItem(sandboxConfig, 'item_sandbox', 'Sandbox Bank')
    seedPlaidItem(productionConfig, 'item_prod', 'Prod Bank')

    const sandboxItems = await listPlaidItems({
      loadConfig: () => sandboxConfig,
      getActivePassphrase: () => PASSPHRASE,
    })
    const productionItems = await listPlaidItems({
      loadConfig: () => productionConfig,
      getActivePassphrase: () => PASSPHRASE,
    })

    expect(sandboxItems.map((i) => i.itemId)).toEqual(['item_sandbox'])
    expect(productionItems.map((i) => i.itemId)).toEqual(['item_prod'])

    // Removing the sandbox item must never touch the production file.
    await removePlaidItem('item_sandbox', {
      loadConfig: () => sandboxConfig,
      getActivePassphrase: () => PASSPHRASE,
      loadPlaidCredentials: () => null,
    })
    const stillProd = await listPlaidItems({
      loadConfig: () => productionConfig,
      getActivePassphrase: () => PASSPHRASE,
    })
    expect(stillProd.map((i) => i.itemId)).toEqual(['item_prod'])
  })

  it('best-effort revocation is built with the ACTIVE env credentials and env, not a fixed one', async () => {
    const config = makeConfig({ plaid_env: 'production' })
    seedPlaidItem(config, 'item_1', 'First Bank')
    let capturedEnv: CladConfig['plaid_env'] | undefined
    let capturedCreds: { clientId: string; secret: string } | undefined

    const result = await removePlaidItem('item_1', {
      loadConfig: () => config,
      getActivePassphrase: () => PASSPHRASE,
      loadPlaidCredentials: () => ({ clientId: 'prod-id', secret: 'prod-secret' }),
      createClient: (creds, plaidEnv) => {
        capturedCreds = creds
        capturedEnv = plaidEnv
        return makeFakeClient()
      },
    })

    expect(result.ok).toBe(true)
    expect(capturedEnv).toBe('production')
    expect(capturedCreds).toEqual({ clientId: 'prod-id', secret: 'prod-secret' })
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

  it('lists each item\'s distinct institutions (sorted, de-duplicated), never accounts or an access URL', async () => {
    const config = makeConfig()
    // One access URL spanning two institutions — the shape a single item can't
    // express through institutionName alone. Two accounts share Chime to prove
    // de-duplication; the alphabetically-later Chime proves the sort.
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
    store.saveItem({ itemId: 'sf_1', institutionName: 'SimpleFIN Bridge', accessToken: SIMPLEFIN_ACCESS_URL })
    store.close()
    const cache = new SimpleFinCache({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
    cache.recordFetch(
      'sf_1',
      [
        { id: 'simplefin:a1', name: 'Everyday Checking', type: 'checking', institution: 'Chime', mask: '1234', balance_current: 100, currency: 'USD' },
        { id: 'simplefin:a2', name: 'Savings', type: 'depository', institution: 'Chime', balance_current: 50, currency: 'USD' },
        { id: 'simplefin:a3', name: 'Rewards Card', type: 'credit', institution: 'Amex', balance_current: -20, currency: 'USD' },
      ],
      []
    )
    cache.close()

    const items = await listSimpleFinItems({ loadConfig: () => config, getActivePassphrase: () => PASSPHRASE })
    expect(items).toHaveLength(1)
    // Sorted + de-duplicated: Amex before Chime, Chime once.
    expect(items[0]?.institutions).toEqual(['Amex', 'Chime'])
    // Account-level detail (names, masks) must never reach the renderer.
    const serialized = JSON.stringify(items)
    expect(serialized).not.toContain('Everyday Checking')
    expect(serialized).not.toContain('1234')
    assertNoSecret(serialized)
  })

  it('labels an account with no resolvable institution as "Unknown institution"', async () => {
    const config = makeConfig()
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
    store.saveItem({ itemId: 'sf_1', institutionName: 'SimpleFIN Bridge', accessToken: SIMPLEFIN_ACCESS_URL })
    store.close()
    const cache = new SimpleFinCache({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
    cache.recordFetch(
      'sf_1',
      [{ id: 'simplefin:a1', name: 'Mystery', type: 'checking', balance_current: 0, currency: 'USD' }],
      []
    )
    cache.close()

    const items = await listSimpleFinItems({ loadConfig: () => config, getActivePassphrase: () => PASSPHRASE })
    expect(items[0]?.institutions).toEqual(['Unknown institution'])
  })

  it('leaves institutions undefined for an item with nothing cached yet', async () => {
    const config = makeConfig()
    // Token stored, but no recordFetch — e.g. the initial summary fetch failed.
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
    store.saveItem({ itemId: 'sf_1', institutionName: 'SimpleFIN Bridge', accessToken: SIMPLEFIN_ACCESS_URL })
    store.close()

    const items = await listSimpleFinItems({ loadConfig: () => config, getActivePassphrase: () => PASSPHRASE })
    expect(items).toHaveLength(1)
    expect(items[0]?.institutions).toBeUndefined()
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
    const cache = new SimpleFinCache({ dbPath: config.simplefin_db, passphrase: PASSPHRASE })
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

    expect(existsSync(activePlaidDbPath(config))).toBe(true)
    const store = new SqliteTokenStore({ dbPath: activePlaidDbPath(config), passphrase: PASSPHRASE })
    expect(store.listItems().map((i) => i.itemId)).toEqual(['item_1'])
    store.close()
  })
})
