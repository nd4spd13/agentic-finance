import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Account } from '@clad/core'
import { DashboardDataStore, toDashboardAccount, type DashboardDataDeps } from '../src/main/lib/dashboard-data.js'
import type { CladConfig } from '../src/main/lib/config.js'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function makeConfig(overrides: Partial<CladConfig> = {}): CladConfig {
  const base = dir ?? (dir = mkdtempSync(join(tmpdir(), 'clad-desktop-dashboard-data-test-')))
  return {
    policy_path: join(base, 'policy.yaml'),
    audit_db: join(base, 'audit.sqlite'),
    approval_db: join(base, 'approvals.sqlite'),
    server_pid_file: join(base, 'server.pid'),
    provider: 'dummy',
    plaid_db: join(base, 'plaid.sqlite'),
    plaid_env: 'sandbox',
    close_to_tray: true,
    ...overrides,
  }
}

function makeDeps(overrides: Partial<DashboardDataDeps> = {}): DashboardDataDeps {
  return {
    loadConfig: () => makeConfig(),
    loadPlaidCredentials: () => null,
    getActivePassphrase: () => null,
    ...overrides,
  }
}

describe('DashboardDataStore.getSnapshot (dummy provider)', () => {
  it('starts empty with lastRefreshed null — never fetches on its own', () => {
    const store = new DashboardDataStore(makeDeps())
    const snapshot = store.getSnapshot()
    expect(snapshot.state).toBe('ready')
    expect(snapshot.provider).toBe('dummy')
    expect(snapshot.accounts).toEqual([])
    expect(snapshot.transactions).toEqual([])
    expect(snapshot.lastRefreshed).toBeNull()
    expect(snapshot.error).toBeUndefined()
  })

  it('calling getSnapshot() repeatedly never populates data (no hidden fetch)', () => {
    const store = new DashboardDataStore(makeDeps())
    store.getSnapshot()
    store.getSnapshot()
    const snapshot = store.getSnapshot()
    expect(snapshot.lastRefreshed).toBeNull()
    expect(snapshot.accounts).toEqual([])
  })
})

describe('DashboardDataStore.refresh (dummy provider)', () => {
  it('populates accounts and recent transactions from DummyDataProvider, sets lastRefreshed', async () => {
    const store = new DashboardDataStore(makeDeps())
    const snapshot = await store.refresh()

    expect(snapshot.state).toBe('ready')
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.lastRefreshed).not.toBeNull()
    expect(snapshot.accounts.length).toBeGreaterThan(0)
    expect(snapshot.accounts[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      balanceCurrent: expect.any(Number),
      currency: expect.any(String),
    })
    // Never leaks a raw account/routing number field — the mapped shape
    // simply has no such fields to leak (see toDashboardAccount).
    expect(Object.keys(snapshot.accounts[0]).sort()).not.toContain('account_number')
    expect(Object.keys(snapshot.accounts[0]).sort()).not.toContain('routing_number')
    // DummyDataProvider never sets Account.institution — the dashboard's
    // "—" fallback (Dashboard.tsx) is expected for it.
    expect(snapshot.accounts[0].institution).toBeUndefined()

    expect(snapshot.transactions.length).toBeGreaterThan(0)
    // Sorted most-recent-first.
    const dates = snapshot.transactions.map((t) => t.date)
    const sorted = [...dates].sort().reverse()
    expect(dates).toEqual(sorted)
  })

  it('getSnapshot() reflects the cache after a refresh, still without fetching again', async () => {
    const store = new DashboardDataStore(makeDeps())
    await store.refresh()
    const snapshot = store.getSnapshot()
    expect(snapshot.accounts.length).toBeGreaterThan(0)
    expect(snapshot.lastRefreshed).not.toBeNull()
  })
})

describe('DashboardDataStore.invalidate', () => {
  it('drops the cached snapshot back to the empty "never fetched this session" state', async () => {
    const store = new DashboardDataStore(makeDeps())
    await store.refresh()
    expect(store.getSnapshot().accounts.length).toBeGreaterThan(0)

    store.invalidate()

    const snapshot = store.getSnapshot()
    expect(snapshot.state).toBe('ready')
    expect(snapshot.accounts).toEqual([])
    expect(snapshot.transactions).toEqual([])
    expect(snapshot.lastRefreshed).toBeNull()
    expect(snapshot.error).toBeUndefined()
  })

  it('does not fetch on its own — a later refresh repopulates', async () => {
    const store = new DashboardDataStore(makeDeps())
    await store.refresh()
    store.invalidate()
    // Still empty until an explicit refresh.
    expect(store.getSnapshot().lastRefreshed).toBeNull()

    const snapshot = await store.refresh()
    expect(snapshot.accounts.length).toBeGreaterThan(0)
    expect(snapshot.lastRefreshed).not.toBeNull()
  })
})

describe('DashboardDataStore with provider: plaid and missing prerequisites', () => {
  it('getSnapshot reports no-provider-configured with a helpful, display-safe message', () => {
    const store = new DashboardDataStore(
      makeDeps({ loadConfig: () => makeConfig({ provider: 'plaid' }) })
    )
    const snapshot = store.getSnapshot()
    expect(snapshot.state).toBe('no-provider-configured')
    expect(snapshot.error).toContain('Client ID/Secret')
    expect(snapshot.accounts).toEqual([])
  })

  it('refresh() also reports no-provider-configured and never throws', async () => {
    const store = new DashboardDataStore(
      makeDeps({ loadConfig: () => makeConfig({ provider: 'plaid' }) })
    )
    const snapshot = await store.refresh()
    expect(snapshot.state).toBe('no-provider-configured')
    expect(snapshot.lastRefreshed).toBeNull()
  })
})

describe('DashboardDataStore with provider: plaid and a genuine construction failure', () => {
  it('refresh() surfaces a redacted error and getSnapshot reflects state: error', async () => {
    const store = new DashboardDataStore(
      makeDeps({
        loadConfig: () =>
          makeConfig({ provider: 'plaid', plaid_env: 'not-a-real-env' as CladConfig['plaid_env'] }),
        loadPlaidCredentials: () => ({ clientId: 'id', secret: 'my-super-secret-value' }),
        getActivePassphrase: () => 'pass',
      })
    )

    const snapshot = await store.refresh()
    expect(snapshot.state).toBe('error')
    expect(snapshot.error).toContain('PLAID_ENV')
    expect(snapshot.error).not.toContain('my-super-secret-value')

    const again = store.getSnapshot()
    expect(again.state).toBe('error')
    expect(again.error).toBe(snapshot.error)
  })
})

describe('DashboardDataStore switching providers', () => {
  it('switching from a failed plaid config back to dummy clears the error state on the next refresh', async () => {
    let provider: CladConfig['provider'] = 'plaid'
    const store = new DashboardDataStore(
      makeDeps({
        loadConfig: () => makeConfig({ provider, plaid_env: 'not-a-real-env' as CladConfig['plaid_env'] }),
        loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
        getActivePassphrase: () => 'pass',
      })
    )

    const failed = await store.refresh()
    expect(failed.state).toBe('error')

    provider = 'dummy'
    const recovered = await store.refresh()
    expect(recovered.state).toBe('ready')
    expect(recovered.error).toBeUndefined()
    expect(recovered.accounts.length).toBeGreaterThan(0)
  })
})

describe('toDashboardAccount', () => {
  const baseAccount: Account = {
    id: 'acc_1',
    name: 'Checking',
    type: 'checking',
    balance_current: 100,
    currency: 'USD',
  }

  it('carries a provider-populated institution through to the snapshot shape', () => {
    const mapped = toDashboardAccount({ ...baseAccount, institution: 'Fake Bank' })
    expect(mapped.institution).toBe('Fake Bank')
  })

  it('leaves institution undefined when the provider does not populate one (e.g. DummyDataProvider)', () => {
    const mapped = toDashboardAccount(baseAccount)
    expect(mapped.institution).toBeUndefined()
  })
})
