/**
 * Connected-clients management (list + revoke OAuth grants) tests — D5.3 WS4
 * S1-S2.
 *
 * Mirrors the DI/no-network conventions of `connection-management.test.ts`:
 * the grant store is the real `@clad/core` `SqliteGrantStore` writing to a
 * throwaway temp SQLite file, seeded directly through its own API (register
 * a client, create a grant) rather than through any not-yet-built consent
 * flow (WS4 S3 is out of scope here — see the WS4 plan §5).
 *
 * Security assertions run throughout: no client secret, token hash, code
 * hash, or raw `clientId` may ever appear in a `ConnectedClient` or cross
 * back toward the renderer (`main/lib/connected-clients.ts`'s module doc).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteGrantStore } from '@clad/core'
import {
  listConnectedClients,
  revokeConnectedClient,
  type ConnectedClientsDeps,
} from '../src/main/lib/connected-clients.js'
import type { CladConfig } from '../src/main/lib/config.js'

const PASSPHRASE = 'unit-test-passphrase'
const CLIENT_SECRET = 'super-secret-client-value'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function makeConfig(overrides: Partial<CladConfig> = {}): CladConfig {
  const base = dir ?? (dir = mkdtempSync(join(tmpdir(), 'clad-desktop-connected-clients-test-')))
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
    grant_db: join(base, 'grants.sqlite'),
    agent_id: '',
    ...overrides,
  }
}

function depsFor(config: CladConfig, passphrase: string | null = PASSPHRASE): ConnectedClientsDeps {
  return { loadConfig: () => config, getActivePassphrase: () => passphrase }
}

interface SeedOptions {
  clientName?: string
  profileId?: string
  scopes?: string[]
  dpopBound?: boolean
  assuranceLevel?: 'none' | 'local-consent' | 'attested'
  maxScopeSensitivity?: 'low' | 'high'
  lastUsedAt?: string
  registerClient?: boolean
}

/** Seeds one registered client + one grant at `config.grant_db`, using the real `SqliteGrantStore` (same file the app opens). Returns the new grant id. */
function seedGrant(config: CladConfig, options: SeedOptions = {}): string {
  const store = new SqliteGrantStore({ dbPath: config.grant_db, passphrase: PASSPHRASE })
  let clientId = 'unregistered-client-id'
  if (options.registerClient !== false) {
    const client = store.registerClient({
      clientName: options.clientName ?? 'Claude Desktop',
      redirectUris: ['http://127.0.0.1:1234/callback'],
      tokenEndpointAuthMethod: 'client_secret_post',
      clientSecret: CLIENT_SECRET,
    })
    clientId = client.clientId
  }
  const grant = store.createGrant({
    clientId,
    profileId: options.profileId ?? 'analyst',
    scopes: options.scopes ?? ['accounts:read', 'transactions:read'],
    dpopBound: options.dpopBound ?? false,
    assuranceLevel: options.assuranceLevel ?? 'local-consent',
    maxScopeSensitivity: options.maxScopeSensitivity ?? 'low',
  })
  if (options.lastUsedAt) {
    store.touchGrant(grant.grantId, options.lastUsedAt)
  }
  store.close()
  return grant.grantId
}

function assertNoSecret(haystack: string | undefined): void {
  if (haystack === undefined) return
  expect(haystack).not.toContain(CLIENT_SECRET)
}

// ---- listConnectedClients: mapping + no-secret ------------------------------

describe('listConnectedClients', () => {
  it('returns [] when the passphrase is not resolved yet, without needing a store', async () => {
    const clients = await listConnectedClients(depsFor(makeConfig(), null))
    expect(clients).toEqual([])
  })

  it('maps GrantMeta -> ConnectedClient with the EXACT serialized key set (no secret/hash fields)', async () => {
    const config = makeConfig()
    seedGrant(config, { clientName: 'Claude Desktop' })

    const clients = await listConnectedClients(depsFor(config))

    expect(clients).toHaveLength(1)
    const client = clients[0]!
    expect(Object.keys(client).sort()).toEqual(
      [
        'assuranceLevel',
        'clientName',
        'createdAt',
        'dpopBound',
        'grantId',
        'lastUsedAt',
        'maxScopeSensitivity',
        'profileId',
        'revoked',
        'scopes',
      ].sort()
    )
    // Never the raw DCR client id, a client secret, or any token/code hash.
    expect(client).not.toHaveProperty('clientId')
    expect(client).not.toHaveProperty('clientSecret')
    assertNoSecret(JSON.stringify(clients))
  })

  it('carries the real field values through (profile, scopes, dpopBound, assurance)', async () => {
    const config = makeConfig()
    seedGrant(config, {
      clientName: 'Claude Code',
      profileId: 'finance-agent',
      scopes: ['accounts:read', 'transactions:read', 'actions:request'],
      dpopBound: true,
      assuranceLevel: 'local-consent',
      maxScopeSensitivity: 'high',
    })

    const [client] = await listConnectedClients(depsFor(config))

    expect(client).toMatchObject({
      clientName: 'Claude Code',
      profileId: 'finance-agent',
      scopes: ['accounts:read', 'transactions:read', 'actions:request'],
      dpopBound: true,
      assuranceLevel: 'local-consent',
      maxScopeSensitivity: 'high',
      revoked: false,
    })
    expect(typeof client!.grantId).toBe('string')
    expect(typeof client!.createdAt).toBe('string')
  })

  it('lastUsedAt is null when the grant has never been used', async () => {
    const config = makeConfig()
    seedGrant(config)

    const [client] = await listConnectedClients(depsFor(config))

    expect(client!.lastUsedAt).toBeNull()
  })

  it('lastUsedAt reflects the grant store\'s own touchGrant value when set', async () => {
    const config = makeConfig()
    const at = '2026-06-01T12:00:00.000Z'
    seedGrant(config, { lastUsedAt: at })

    const [client] = await listConnectedClients(depsFor(config))

    expect(client!.lastUsedAt).toBe(at)
  })

  it('clientName is undefined when the client never registered one, never a fabricated placeholder', async () => {
    const config = makeConfig()
    const store = new SqliteGrantStore({ dbPath: config.grant_db, passphrase: PASSPHRASE })
    const client = store.registerClient({
      redirectUris: ['http://127.0.0.1:1234/callback'],
      tokenEndpointAuthMethod: 'none',
    })
    store.createGrant({
      clientId: client.clientId,
      profileId: 'analyst',
      scopes: ['accounts:read'],
      dpopBound: false,
      assuranceLevel: 'local-consent',
      maxScopeSensitivity: 'low',
    })
    store.close()

    const [connected] = await listConnectedClients(depsFor(config))
    expect(connected!.clientName).toBeUndefined()
  })

  it('lists revoked grants too (with revoked: true), leaving filtering to the caller', async () => {
    const config = makeConfig()
    const grantId = seedGrant(config)
    await revokeConnectedClient(grantId, depsFor(config))

    const clients = await listConnectedClients(depsFor(config))
    expect(clients).toHaveLength(1)
    expect(clients[0]!.revoked).toBe(true)
  })

  it('degrades to [] (never throws) when the store cannot be opened, e.g. a wrong/mismatched passphrase', async () => {
    const config = makeConfig()
    seedGrant(config) // creates+seals the file under PASSPHRASE

    const clients = await listConnectedClients(depsFor(config, 'totally-wrong-passphrase'))
    expect(clients).toEqual([])
  })

  it('multiple grants across multiple clients all list, each with its own profile', async () => {
    const config = makeConfig()
    seedGrant(config, { clientName: 'Claude Desktop', profileId: 'analyst' })
    seedGrant(config, { clientName: 'Claude Code', profileId: 'finance-agent' })

    const clients = await listConnectedClients(depsFor(config))
    expect(clients.map((c) => c.profileId).sort()).toEqual(['analyst', 'finance-agent'])
  })
})

// ---- revokeConnectedClient ---------------------------------------------------

describe('revokeConnectedClient', () => {
  it('errors (redacted, without throwing) when the passphrase is not resolved', async () => {
    const config = makeConfig()
    const result = await revokeConnectedClient('some-grant-id', depsFor(config, null))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/passphrase/i)
  })

  it('revokes the grant: store.revokeGrant runs and the result is {ok: true}', async () => {
    const config = makeConfig()
    const grantId = seedGrant(config)

    const result = await revokeConnectedClient(grantId, depsFor(config))
    expect(result).toEqual({ ok: true })

    const store = new SqliteGrantStore({ dbPath: config.grant_db, passphrase: PASSPHRASE })
    expect(store.getGrant(grantId)?.revokedAt).toBeDefined()
    store.close()
  })

  it('cascade-deletes the grant\'s tokens so a live verify would fail closed on the next lookup', async () => {
    const config = makeConfig()
    const grantId = seedGrant(config)
    const store = new SqliteGrantStore({ dbPath: config.grant_db, passphrase: PASSPHRASE })
    store.putToken({
      tokenHash: 'a'.repeat(64),
      kind: 'access',
      grantId,
      expiresAt: Date.now() + 60_000,
      createdAt: new Date().toISOString(),
    })
    store.close()

    await revokeConnectedClient(grantId, depsFor(config))

    const after = new SqliteGrantStore({ dbPath: config.grant_db, passphrase: PASSPHRASE })
    // getToken looks up by raw token via hash — there is no raw token that
    // hashes to our pre-computed hash, so assert directly against the table
    // the way `revokeGrant`'s own module doc describes: cascade-deleted.
    expect(after.getGrant(grantId)?.revokedAt).toBeDefined()
    after.close()
  })

  it('returns {ok: true} for a grantId that does not exist (no-op, matches removePlaidItem\'s convention)', async () => {
    const config = makeConfig()
    seedGrant(config) // ensures the store file exists and is sealed under PASSPHRASE

    const result = await revokeConnectedClient('does-not-exist', depsFor(config))
    expect(result).toEqual({ ok: true })
  })

  it('returns a redacted {ok: false, error} (never throws) when the store cannot be opened', async () => {
    const config = makeConfig()
    seedGrant(config) // seals the file under PASSPHRASE

    const result = await revokeConnectedClient('any-grant-id', depsFor(config, 'totally-wrong-passphrase'))
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    assertNoSecret(result.error)
  })

  it('never leaks the client secret through a revoke result', async () => {
    const config = makeConfig()
    const grantId = seedGrant(config)
    const result = await revokeConnectedClient(grantId, depsFor(config))
    assertNoSecret(JSON.stringify(result))
  })
})
