import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { SqliteGrantStore } from '../../src/security/grant-store.js'
import type {
  RegisterClientInput,
  StoredGrant,
  StoredToken,
} from '../../src/security/grant-store.js'
import { TokenStoreKeyError } from '../../src/security/token-store-errors.js'

const PASSPHRASE = 'correct horse battery staple'
const WRONG_PASSPHRASE = 'incorrect zebra dynamo paperclip'

const SAMPLE_ACCESS_TOKEN = 'raw-access-token-Zx91kfjs82-do-not-store-me'
const SAMPLE_REFRESH_TOKEN = 'raw-refresh-token-Qp72mnvbe11-do-not-store-me'
const SAMPLE_AUTH_CODE = 'raw-auth-code-Lm38pqzx-single-use'
const SAMPLE_CLIENT_SECRET = 'super-confidential-client-secret-9f3a'
const SAMPLE_CLIENT_NAME = 'Acme Budgeting Agent (untrusted display name)'

/** SHA-256 hex, matching the store's private hashing of opaque tokens/codes. */
function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-grant-store-'))
  dbPath = join(dir, 'grants.sqlite')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function open(passphrase = PASSPHRASE): SqliteGrantStore {
  return new SqliteGrantStore({ dbPath, passphrase })
}

function sampleClientInput(overrides: Partial<RegisterClientInput> = {}): RegisterClientInput {
  return {
    clientName: SAMPLE_CLIENT_NAME,
    redirectUris: ['https://app.example/callback'],
    tokenEndpointAuthMethod: 'client_secret_post',
    clientSecret: SAMPLE_CLIENT_SECRET,
    ...overrides,
  }
}

function sampleGrantInput(
  clientId: string,
  overrides: Partial<Omit<StoredGrant, 'grantId' | 'createdAt'>> = {}
): Omit<StoredGrant, 'grantId' | 'createdAt'> {
  return {
    clientId,
    profileId: 'profile-alpha',
    scopes: ['accounts:read', 'transactions:read'],
    dpopBound: true,
    assuranceLevel: 'local-consent',
    maxScopeSensitivity: 'high',
    ...overrides,
  }
}

function accessToken(raw: string, grantId: string, overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    tokenHash: sha256Hex(raw),
    kind: 'access',
    grantId,
    jkt: 'public-dpop-thumbprint-abc',
    expiresAt: Date.now() + 60_000,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('SqliteGrantStore — client + grant + token round-trip', () => {
  it('registers a client and reads it back (secret write-only, name decrypted)', () => {
    const store = open()
    const registered = store.registerClient(sampleClientInput())

    expect(registered.clientId).toBeTruthy()
    expect(registered.clientName).toBe(SAMPLE_CLIENT_NAME)
    // The returned StoredClient never carries the raw secret back.
    expect(JSON.stringify(registered)).not.toContain(SAMPLE_CLIENT_SECRET)

    const fetched = store.getClient(registered.clientId)
    expect(fetched).toBeDefined()
    expect(fetched?.clientName).toBe(SAMPLE_CLIENT_NAME)
    expect(fetched?.redirectUris).toEqual(['https://app.example/callback'])
    expect(fetched?.tokenEndpointAuthMethod).toBe('client_secret_post')
    // getClient deliberately never selects the secret columns.
    expect(JSON.stringify(fetched)).not.toContain(SAMPLE_CLIENT_SECRET)
    store.close()
  })

  it('creates a grant and reads it back with WS7 assurance metadata', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const created = store.createGrant(sampleGrantInput(client.clientId))

    expect(created.grantId).toBeTruthy()
    expect(created.createdAt).toBeTruthy()

    const fetched = store.getGrant(created.grantId)
    expect(fetched).toBeDefined()
    expect(fetched?.clientId).toBe(client.clientId)
    expect(fetched?.profileId).toBe('profile-alpha')
    expect(fetched?.scopes).toEqual(['accounts:read', 'transactions:read'])
    expect(fetched?.dpopBound).toBe(true)
    expect(fetched?.assuranceLevel).toBe('local-consent')
    expect(fetched?.maxScopeSensitivity).toBe('high')
    expect(fetched?.revokedAt).toBeUndefined()
    store.close()
  })

  it('putToken then getToken(raw) hashes and matches; unknown token is undefined', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))
    store.putToken(accessToken(SAMPLE_ACCESS_TOKEN, grant.grantId))

    const found = store.getToken(SAMPLE_ACCESS_TOKEN)
    expect(found).toBeDefined()
    expect(found?.kind).toBe('access')
    expect(found?.grantId).toBe(grant.grantId)
    expect(found?.tokenHash).toBe(sha256Hex(SAMPLE_ACCESS_TOKEN))
    expect(found?.jkt).toBe('public-dpop-thumbprint-abc')

    expect(store.getToken('some-other-token-never-stored')).toBeUndefined()
    store.close()
  })

  it('persists across close/reopen with the correct passphrase', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))
    store.putToken(accessToken(SAMPLE_ACCESS_TOKEN, grant.grantId))
    store.close()

    const reopened = open()
    expect(reopened.getClient(client.clientId)?.clientName).toBe(SAMPLE_CLIENT_NAME)
    expect(reopened.getGrant(grant.grantId)?.profileId).toBe('profile-alpha')
    expect(reopened.getToken(SAMPLE_ACCESS_TOKEN)?.grantId).toBe(grant.grantId)
    reopened.close()
  })
})

describe('SqliteGrantStore — wrong passphrase', () => {
  it('throws TokenStoreKeyError when reopened with the wrong passphrase', () => {
    const store = open()
    store.registerClient(sampleClientInput())
    store.close()

    expect(() => open(WRONG_PASSPHRASE)).toThrow(TokenStoreKeyError)
  })

  it('the TokenStoreKeyError leaks neither passphrase nor secret', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    store.createGrant(sampleGrantInput(client.clientId))
    store.close()

    let caught: unknown
    try {
      open(WRONG_PASSPHRASE)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TokenStoreKeyError)
    const message = (caught as Error).message
    expect(message).not.toContain(WRONG_PASSPHRASE)
    expect(message).not.toContain(PASSPHRASE)
    expect(message).not.toContain(SAMPLE_CLIENT_SECRET)
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught))
    expect(serialized).not.toContain(WRONG_PASSPHRASE)
    expect(serialized).not.toContain(PASSPHRASE)
  })
})

describe('SqliteGrantStore — file permissions (0600)', () => {
  it('creates the DB file with mode 0600', () => {
    const store = open()
    store.registerClient(sampleClientInput())
    store.close()
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
  })

  it('re-applies 0600 on reopen if the file mode drifted', () => {
    const store = open()
    store.close()
    chmodSync(dbPath, 0o644)
    const reopened = open()
    reopened.close()
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
  })
})

describe('SqliteGrantStore — no plaintext token/secret at rest', () => {
  it('does not store raw token, auth code, client secret, or client name in DB bytes', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))
    store.putToken(accessToken(SAMPLE_ACCESS_TOKEN, grant.grantId))
    store.putToken(
      accessToken(SAMPLE_REFRESH_TOKEN, grant.grantId, {
        tokenHash: sha256Hex(SAMPLE_REFRESH_TOKEN),
        kind: 'refresh',
      })
    )
    store.putAuthCode({
      code: SAMPLE_AUTH_CODE,
      grantId: grant.grantId,
      codeChallenge: 'public-s256-challenge',
      redirectUri: 'https://app.example/callback',
      expiresAt: Date.now() + 60_000,
    })
    store.close()

    const raw = readFileSync(dbPath)
    const latin1 = raw.toString('latin1')
    const utf8 = raw.toString('utf8')

    for (const secret of [
      SAMPLE_ACCESS_TOKEN,
      SAMPLE_REFRESH_TOKEN,
      SAMPLE_AUTH_CODE,
      SAMPLE_CLIENT_SECRET,
      SAMPLE_CLIENT_NAME,
    ]) {
      expect(raw.includes(Buffer.from(secret, 'utf8'))).toBe(false)
      expect(latin1).not.toContain(secret)
      expect(utf8).not.toContain(secret)
    }
  })
})

describe('SqliteGrantStore — single-use auth codes', () => {
  it('consumeAuthCode returns the code once, then undefined (replay rejected)', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))
    store.putAuthCode({
      code: SAMPLE_AUTH_CODE,
      grantId: grant.grantId,
      codeChallenge: 'public-s256-challenge',
      redirectUri: 'https://app.example/callback',
      expiresAt: Date.now() + 60_000,
    })

    const first = store.consumeAuthCode(SAMPLE_AUTH_CODE)
    expect(first).toBeDefined()
    expect(first?.grantId).toBe(grant.grantId)
    expect(first?.codeChallenge).toBe('public-s256-challenge')

    expect(store.consumeAuthCode(SAMPLE_AUTH_CODE)).toBeUndefined()
    store.close()
  })

  it('does not return an already-expired code', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))
    store.putAuthCode({
      code: SAMPLE_AUTH_CODE,
      grantId: grant.grantId,
      codeChallenge: 'public-s256-challenge',
      redirectUri: 'https://app.example/callback',
      expiresAt: Date.now() - 1_000,
    })
    expect(store.consumeAuthCode(SAMPLE_AUTH_CODE)).toBeUndefined()
    store.close()
  })
})

describe('SqliteGrantStore — revoke cascade', () => {
  it('revokeGrant marks the grant revoked and deletes its tokens + codes', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))
    store.putToken(accessToken(SAMPLE_ACCESS_TOKEN, grant.grantId))
    store.putAuthCode({
      code: SAMPLE_AUTH_CODE,
      grantId: grant.grantId,
      codeChallenge: 'public-s256-challenge',
      redirectUri: 'https://app.example/callback',
      expiresAt: Date.now() + 60_000,
    })

    store.revokeGrant(grant.grantId)

    // Cascade: live credentials are gone, so WS2 verifyAccessToken fails closed.
    expect(store.getToken(SAMPLE_ACCESS_TOKEN)).toBeUndefined()
    expect(store.consumeAuthCode(SAMPLE_AUTH_CODE)).toBeUndefined()

    // The grant row is retained (for WS4's list) but flagged revoked.
    const revoked = store.getGrant(grant.grantId)
    expect(revoked?.revokedAt).toBeTruthy()
    expect(store.listGrants().find((g) => g.grantId === grant.grantId)?.revoked).toBe(true)
    store.close()
  })
})

describe('SqliteGrantStore — refresh rotation', () => {
  it('rotateRefresh invalidates the old token and issues the new one atomically', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))

    const oldRefresh = accessToken(SAMPLE_REFRESH_TOKEN, grant.grantId, {
      tokenHash: sha256Hex(SAMPLE_REFRESH_TOKEN),
      kind: 'refresh',
    })
    store.putToken(oldRefresh)

    const nextRaw = 'raw-refresh-token-rotated-Ab99-new'
    const next = accessToken(nextRaw, grant.grantId, {
      tokenHash: sha256Hex(nextRaw),
      kind: 'refresh',
      rotatedFrom: sha256Hex(SAMPLE_REFRESH_TOKEN),
    })
    store.rotateRefresh(SAMPLE_REFRESH_TOKEN, next)

    expect(store.getToken(SAMPLE_REFRESH_TOKEN)).toBeUndefined()
    const rotated = store.getToken(nextRaw)
    expect(rotated).toBeDefined()
    expect(rotated?.rotatedFrom).toBe(sha256Hex(SAMPLE_REFRESH_TOKEN))
    store.close()
  })
})

describe('SqliteGrantStore — expiry filtering and purge', () => {
  it('getToken past expiresAt returns undefined', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))
    store.putToken(
      accessToken(SAMPLE_ACCESS_TOKEN, grant.grantId, { expiresAt: Date.now() - 1_000 })
    )
    expect(store.getToken(SAMPLE_ACCESS_TOKEN)).toBeUndefined()
    store.close()
  })

  it('purgeExpired physically removes expired rows and keeps live ones', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))

    const expiredRaw = 'raw-expired-token-Kd21'
    const liveRaw = 'raw-live-token-Mn55'
    store.putToken(accessToken(expiredRaw, grant.grantId, { expiresAt: Date.now() - 1_000 }))
    store.putToken(accessToken(liveRaw, grant.grantId, { expiresAt: Date.now() + 60_000 }))

    store.purgeExpired(Date.now())

    // Live token survives.
    expect(store.getToken(liveRaw)?.grantId).toBe(grant.grantId)
    // Expired row is physically gone: re-inserting its hash must not hit a PK conflict.
    expect(() =>
      store.putToken(accessToken(expiredRaw, grant.grantId, { expiresAt: Date.now() + 60_000 }))
    ).not.toThrow()
    expect(store.getToken(expiredRaw)).toBeDefined()
    store.close()
  })
})

describe('SqliteGrantStore — client->profile binding is set-once', () => {
  // NOTE (v0.7.1 fix #1): set-once still holds for a plain rebind attempt —
  // see this block's tests. The ONLY new escape hatch is `revokeGrant`
  // clearing the binding once no unrevoked grant remains for the client (its
  // own describe block above), which is a distinct, human-revoke-gated path.
  it('rejects a second bind to a different profile, allows an idempotent re-bind', () => {
    const store = open()
    const client = store.registerClient(
      sampleClientInput({ clientName: undefined, clientSecret: undefined })
    )

    store.bindClientProfile(client.clientId, 'profile-alpha')
    expect(store.getClient(client.clientId)?.boundProfileId).toBe('profile-alpha')

    // Idempotent re-bind to the SAME profile is allowed.
    expect(() => store.bindClientProfile(client.clientId, 'profile-alpha')).not.toThrow()

    // Re-binding to a DIFFERENT profile is rejected (immutability — acceptance #1).
    expect(() => store.bindClientProfile(client.clientId, 'profile-beta')).toThrow()
    expect(store.getClient(client.clientId)?.boundProfileId).toBe('profile-alpha')
    store.close()
  })

  it('the immutability error carries no profile id or secret material', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    store.bindClientProfile(client.clientId, 'profile-alpha')

    let caught: unknown
    try {
      store.bindClientProfile(client.clientId, 'profile-beta')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).not.toContain('profile-alpha')
    expect(message).not.toContain('profile-beta')
    expect(message).not.toContain(SAMPLE_CLIENT_SECRET)
    store.close()
  })
})

describe('SqliteGrantStore — revoke clears the client->profile binding (v0.7.1 fix #1)', () => {
  it('revoking a client\'s ONLY grant clears bound_profile_id, allowing a rebind to a different profile', () => {
    const store = open()
    const client = store.registerClient(
      sampleClientInput({ clientName: undefined, clientSecret: undefined })
    )
    store.bindClientProfile(client.clientId, 'analyst')
    const grant = store.createGrant(sampleGrantInput(client.clientId, { profileId: 'analyst' }))
    expect(store.getClient(client.clientId)?.boundProfileId).toBe('analyst')

    store.revokeGrant(grant.grantId)

    // Binding is cleared — the next consent is a genuinely fresh choice.
    expect(store.getClient(client.clientId)?.boundProfileId).toBeUndefined()
    expect(() => store.bindClientProfile(client.clientId, 'finance-agent')).not.toThrow()
    expect(store.getClient(client.clientId)?.boundProfileId).toBe('finance-agent')
    store.close()
  })

  it('rebind WITHOUT a revoke is still refused (set-once immutability is untouched by this fix)', () => {
    const store = open()
    const client = store.registerClient(
      sampleClientInput({ clientName: undefined, clientSecret: undefined })
    )
    store.bindClientProfile(client.clientId, 'analyst')
    store.createGrant(sampleGrantInput(client.clientId, { profileId: 'analyst' }))

    // No revoke happened — a straight rebind attempt must still be rejected.
    expect(() => store.bindClientProfile(client.clientId, 'finance-agent')).toThrow()
    expect(store.getClient(client.clientId)?.boundProfileId).toBe('analyst')
    store.close()
  })

  it('a client with MULTIPLE grants keeps its binding until the LAST unrevoked grant is revoked', () => {
    const store = open()
    const client = store.registerClient(
      sampleClientInput({ clientName: undefined, clientSecret: undefined })
    )
    store.bindClientProfile(client.clientId, 'analyst')
    // Two grants for the SAME client+profile (e.g. re-authorized after a
    // refresh-token expiry) — cardinality is one client -> many grants.
    const first = store.createGrant(sampleGrantInput(client.clientId, { profileId: 'analyst' }))
    const second = store.createGrant(sampleGrantInput(client.clientId, { profileId: 'analyst' }))

    store.revokeGrant(first.grantId)
    // One unrevoked grant (`second`) still exists for this client — binding stays.
    expect(store.getClient(client.clientId)?.boundProfileId).toBe('analyst')
    expect(() => store.bindClientProfile(client.clientId, 'finance-agent')).toThrow()

    store.revokeGrant(second.grantId)
    // Now the LAST unrevoked grant is gone — binding clears.
    expect(store.getClient(client.clientId)?.boundProfileId).toBeUndefined()
    expect(() => store.bindClientProfile(client.clientId, 'finance-agent')).not.toThrow()
    store.close()
  })

  it('revoking an already-revoked grant is a harmless no-op for the binding', () => {
    const store = open()
    const client = store.registerClient(
      sampleClientInput({ clientName: undefined, clientSecret: undefined })
    )
    store.bindClientProfile(client.clientId, 'analyst')
    const grant = store.createGrant(sampleGrantInput(client.clientId, { profileId: 'analyst' }))
    store.revokeGrant(grant.grantId)
    expect(store.getClient(client.clientId)?.boundProfileId).toBeUndefined()

    // Second revoke of the same (already-revoked) grant: still a no-op, no throw.
    expect(() => store.revokeGrant(grant.grantId)).not.toThrow()
    expect(store.getClient(client.clientId)?.boundProfileId).toBeUndefined()
    store.close()
  })

  it('revoking an unknown grantId does not throw and touches no binding', () => {
    const store = open()
    const client = store.registerClient(
      sampleClientInput({ clientName: undefined, clientSecret: undefined })
    )
    store.bindClientProfile(client.clientId, 'analyst')
    expect(() => store.revokeGrant('not-a-real-grant-id')).not.toThrow()
    expect(store.getClient(client.clientId)?.boundProfileId).toBe('analyst')
    store.close()
  })
})

describe('SqliteGrantStore — listGrants / GrantMeta carries no secret or hash', () => {
  it('returns display-safe metadata only', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))
    store.putToken(accessToken(SAMPLE_ACCESS_TOKEN, grant.grantId))

    const list = store.listGrants()
    expect(list).toHaveLength(1)
    const meta = list[0]

    // Exactly the GrantMeta keys, nothing else.
    expect(Object.keys(meta).sort()).toEqual(
      [
        'assuranceLevel',
        'clientId',
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

    // Display-safe clientName decrypts through; no secrets/hashes escape.
    expect(meta.clientName).toBe(SAMPLE_CLIENT_NAME)
    const serialized = JSON.stringify(list)
    expect(serialized).not.toContain(SAMPLE_CLIENT_SECRET)
    expect(serialized).not.toContain(sha256Hex(SAMPLE_ACCESS_TOKEN))
    expect(serialized).not.toContain(SAMPLE_ACCESS_TOKEN)
    store.close()
  })

  it('touchGrant updates lastUsedAt shown in the list', () => {
    const store = open()
    const client = store.registerClient(sampleClientInput())
    const grant = store.createGrant(sampleGrantInput(client.clientId))

    const at = new Date().toISOString()
    store.touchGrant(grant.grantId, at)
    expect(store.getGrant(grant.grantId)?.lastUsedAt).toBe(at)
    expect(store.listGrants()[0].lastUsedAt).toBe(at)
    store.close()
  })
})
