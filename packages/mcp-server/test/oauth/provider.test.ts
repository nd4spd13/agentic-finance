/**
 * D5.3 WS2 S4-S6 coverage: `CladOAuthProvider`'s REAL flow methods
 * (`../../src/oauth/provider.ts`), backed by a temp-file `SqliteGrantStore`
 * and a real `LocalConsentTrustProvider` — no mock at the store/trust boundary,
 * matching the rest of this package's test policy.
 *
 * Two halves:
 *  1. `clientsStore` — RFC 7591 DCR round-trips (public + confidential).
 *  2. The six flow methods, now implemented: `authorize` (S256 PKCE, single-use
 *     expiring codes, set-once binding, consent seam, WS7 scope narrowing);
 *     `challengeForAuthorizationCode`; `exchangeAuthorizationCode` (single-use,
 *     expiry, redirect_uri + client checks); `verifyAccessToken`;
 *     `exchangeRefreshToken` (rotation); `revokeToken`; plus the
 *     confidential-client secret-verification path (`authenticateTokenRequestClient`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Response } from 'express'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { SqliteGrantStore, LocalConsentTrustProvider, type PolicyConfig } from '@clad/core'
import { CladOAuthProvider, type CladOAuthProviderDeps } from '../../src/oauth/provider.js'
import { mintScopesForProfile, scopeSensitivity } from '../../src/oauth/scope-minter.js'
import { denyingConsent, type ConsentFn } from '../../src/oauth/consent.js'

const POLICY: PolicyConfig = {
  agents: {
    analyst: {
      description: 'read-only analyst',
      permissions: {
        accounts: { visible: ['checking'], balance: true },
        transactions: { read: true },
      },
    },
    // Action-bearing profile: `spending` present -> `clad:actions.request`
    // (high sensitivity). Used to prove a bearer-only grant is narrowed.
    spender: {
      description: 'action-bearing spender',
      permissions: {
        accounts: { visible: ['checking'], balance: true },
        spending: {},
      },
    },
  },
}

const REDIRECT = 'https://example.com/callback'

let dir: string
let store: SqliteGrantStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-oauth-provider-'))
  store = new SqliteGrantStore({ dbPath: join(dir, 'grants.sqlite'), passphrase: 'provider-test-passphrase' })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Approve consent for a fixed profile (the WS4 seam, faked for tests). */
const approve = (profileId: string, dpopBound = false): ConsentFn => async () => ({
  approved: true,
  profileId,
  dpopBound,
})

function makeProvider(overrides: Partial<CladOAuthProviderDeps> = {}): CladOAuthProvider {
  const policy = overrides.policy ?? POLICY
  return new CladOAuthProvider({
    store,
    policy,
    trust: overrides.trust ?? new LocalConsentTrustProvider(policy, mintScopesForProfile, scopeSensitivity),
    requestConsent: overrides.requestConsent ?? approve('analyst'),
    now: overrides.now,
  })
}

function sha256hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

interface CapturedRedirect {
  status?: number
  url?: string
}

/** Minimal `express.Response` stand-in capturing the `res.redirect(status, url)` the SDK expects. */
function fakeRes(captured: CapturedRedirect): Response {
  return {
    redirect: (status: number, url: string) => {
      captured.status = status
      captured.url = url
    },
  } as unknown as Response
}

async function registerPublicClient(
  provider: CladOAuthProvider,
  redirectUri = REDIRECT
): Promise<OAuthClientInformationFull> {
  return provider.clientsStore.registerClient!({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    client_name: 'Public Test Client',
  })
}

/** Runs authorize with a real (fake-consent) provider and returns the issued single-use code + PKCE material. */
async function authorizeToCode(
  provider: CladOAuthProvider,
  client: OAuthClientInformationFull,
  opts: { redirectUri?: string; state?: string } = {}
): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(32).toString('base64url')
  const captured: CapturedRedirect = {}
  await provider.authorize(
    client,
    { codeChallenge: s256Challenge(verifier), redirectUri: opts.redirectUri ?? REDIRECT, state: opts.state },
    fakeRes(captured)
  )
  const code = new URL(captured.url!).searchParams.get('code')
  return { code: code!, verifier }
}

describe('CladOAuthProvider.clientsStore — RFC 7591 DCR over SqliteGrantStore', () => {
  it('registers a public client (no secret) and reads it back', async () => {
    const provider = makeProvider()
    const registered = await provider.clientsStore.registerClient!({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: 'Public Test Client',
    })

    expect(registered.client_id).toBeTruthy()
    expect(registered.client_secret).toBeUndefined()
    expect(registered.token_endpoint_auth_method).toBe('none')

    const read = await provider.clientsStore.getClient(registered.client_id)
    expect(read?.client_id).toBe(registered.client_id)
    expect(read?.redirect_uris).toEqual([REDIRECT])
    expect(read?.client_name).toBe('Public Test Client')
  })

  it('persists a confidential client secret encrypted, echoes it ONCE, and never returns it on a later read', async () => {
    const provider = makeProvider()
    const registered = await provider.clientsStore.registerClient!({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
      client_secret: 'sdk-generated-secret-abc123',
      client_secret_expires_at: Math.floor(Date.now() / 1000) + 3600,
    })

    expect(registered.client_secret).toBe('sdk-generated-secret-abc123')
    expect(registered.token_endpoint_auth_method).toBe('client_secret_post')

    const read = await provider.clientsStore.getClient(registered.client_id)
    expect(read?.client_secret).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain('sdk-generated-secret-abc123')
  })

  it('maps an absent client_secret to "none", a present one to "client_secret_post"', async () => {
    const provider = makeProvider()
    const pub = await provider.clientsStore.registerClient!({ redirect_uris: [REDIRECT] })
    expect(pub.token_endpoint_auth_method).toBe('none')
    const conf = await provider.clientsStore.registerClient!({ redirect_uris: [REDIRECT], client_secret: 'x' })
    expect(conf.token_endpoint_auth_method).toBe('client_secret_post')
  })

  it('getClient returns undefined for an unknown client id', async () => {
    const provider = makeProvider()
    expect(await provider.clientsStore.getClient('nonexistent')).toBeUndefined()
  })
})

describe('authorize() — S256 PKCE, consent seam, single-use expiring code, set-once binding', () => {
  it('on approval, persists a single-use pending grant + auth code and redirects with code + state', async () => {
    const provider = makeProvider({ requestConsent: approve('analyst') })
    const client = await registerPublicClient(provider)

    const verifier = randomBytes(32).toString('base64url')
    const captured: CapturedRedirect = {}
    await provider.authorize(
      client,
      { codeChallenge: s256Challenge(verifier), redirectUri: REDIRECT, state: 'state-123' },
      fakeRes(captured)
    )

    expect(captured.status).toBe(302)
    const url = new URL(captured.url!)
    expect(url.origin + url.pathname).toBe(REDIRECT)
    expect(url.searchParams.get('state')).toBe('state-123')
    const code = url.searchParams.get('code')
    expect(code).toBeTruthy()

    // The binding is now persisted (acceptance #1) and the code is redeemable.
    expect(store.getClient(client.client_id)?.boundProfileId).toBe('analyst')
    expect(store.getAuthCode(code!)?.codeChallenge).toBe(s256Challenge(verifier))
  })

  it('deny-by-default consent throws AccessDeniedError and binds/creates nothing', async () => {
    const provider = makeProvider({ requestConsent: denyingConsent })
    const client = await registerPublicClient(provider)

    await expect(
      provider.authorize(client, { codeChallenge: s256Challenge('v'), redirectUri: REDIRECT }, fakeRes({}))
    ).rejects.toThrow(AccessDeniedError)

    expect(store.getClient(client.client_id)?.boundProfileId).toBeUndefined()
  })

  it('refuses (AccessDeniedError) without rendering consent when no profile is eligible', async () => {
    const emptyPolicy: PolicyConfig = { agents: {} }
    let consentCalled = false
    const provider = makeProvider({
      policy: emptyPolicy,
      requestConsent: async () => {
        consentCalled = true
        return { approved: true, profileId: 'anything', dpopBound: false }
      },
    })
    const client = await registerPublicClient(provider)

    await expect(
      provider.authorize(client, { codeChallenge: s256Challenge('v'), redirectUri: REDIRECT }, fakeRes({}))
    ).rejects.toThrow(AccessDeniedError)
    expect(consentCalled).toBe(false)
  })

  it('rejects a consent decision that selects a profile the trust layer did not deem eligible', async () => {
    const provider = makeProvider({ requestConsent: approve('not-a-real-profile') })
    const client = await registerPublicClient(provider)

    await expect(
      provider.authorize(client, { codeChallenge: s256Challenge('v'), redirectUri: REDIRECT }, fakeRes({}))
    ).rejects.toThrow(AccessDeniedError)
  })

  it('narrows a bearer-only grant: an action-bearing profile does NOT mint clad:actions.request (WS7 §4 gate)', async () => {
    const provider = makeProvider({ requestConsent: approve('spender') }) // dpopBound false -> bearer
    const client = await registerPublicClient(provider)
    const { code } = await authorizeToCode(provider, client)

    const grant = store.getGrant(store.getAuthCode(code)!.grantId)!
    // `spender` would mint clad:actions.request (high), but a bearer client is
    // capped at 'low' — so the stored grant carries only the read scope.
    expect(grant.scopes).toContain('clad:accounts.read')
    expect(grant.scopes).not.toContain('clad:actions.request')
    expect(grant.maxScopeSensitivity).toBe('low')
  })

  it('enforces set-once binding: re-authorizing the same client to a DIFFERENT profile is denied', async () => {
    const provider = makeProvider({ requestConsent: approve('analyst') })
    const client = await registerPublicClient(provider)
    await authorizeToCode(provider, client) // binds to analyst

    const reprovider = makeProvider({ requestConsent: approve('spender') })
    await expect(
      reprovider.authorize(client, { codeChallenge: s256Challenge('v'), redirectUri: REDIRECT }, fakeRes({}))
    ).rejects.toThrow(AccessDeniedError)
    expect(store.getClient(client.client_id)?.boundProfileId).toBe('analyst')
  })
})

describe('challengeForAuthorizationCode() — non-consuming challenge peek', () => {
  it('returns the stored S256 challenge without consuming the code', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)

    const challenge = await provider.challengeForAuthorizationCode(client, code)
    expect(challenge).toBe(s256Challenge(verifier))

    // Still redeemable afterwards (the peek didn't mark it consumed).
    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)
    expect(tokens.access_token).toBeTruthy()
  })

  it('throws InvalidGrantError for a fabricated code', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    await expect(provider.challengeForAuthorizationCode(client, 'fabricated')).rejects.toThrow(InvalidGrantError)
  })
})

describe('exchangeAuthorizationCode() — single-use redemption, scope from grant', () => {
  it('issues opaque access + refresh tokens carrying the grant scope; token_type Bearer (M2)', async () => {
    const provider = makeProvider({ requestConsent: approve('analyst') })
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)

    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token).toBeTruthy()
    expect(tokens.scope).toBe('clad:accounts.read clad:transactions.read')

    // The access token verifies to the bound profile.
    const info = await provider.verifyAccessToken(tokens.access_token)
    expect(info.extra?.profileId).toBe('analyst')
  })

  it('is single-use: replaying the same code is rejected (InvalidGrantError)', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)

    await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)
    await expect(provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)).rejects.toThrow(
      InvalidGrantError
    )
  })

  it('rejects an expired authorization code (InvalidGrantError)', async () => {
    // Provider clock 10 minutes in the past: the 60s code TTL is already blown
    // vs. the store's real-time expiry filter.
    const provider = makeProvider({ now: () => Date.now() - 10 * 60 * 1000 })
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)

    await expect(provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)).rejects.toThrow(
      InvalidGrantError
    )
  })

  it('rejects a redirect_uri that does not match the authorization request', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)

    await expect(
      provider.exchangeAuthorizationCode(client, code, verifier, 'https://evil.example.com/callback')
    ).rejects.toThrow(InvalidGrantError)
  })

  it('rejects a code presented by a different client than the one it was issued to', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)

    const otherClient = await registerPublicClient(provider)
    await expect(
      provider.exchangeAuthorizationCode(otherClient, code, verifier, REDIRECT)
    ).rejects.toThrow(InvalidGrantError)
  })
})

describe('verifyAccessToken() — opaque store lookup returning AuthInfo', () => {
  it('returns AuthInfo with the bound profileId, scopes and second-granularity expiry', async () => {
    const provider = makeProvider({ requestConsent: approve('analyst') })
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)
    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)

    const info = await provider.verifyAccessToken(tokens.access_token)
    expect(info.clientId).toBe(client.client_id)
    expect(info.scopes).toEqual(['clad:accounts.read', 'clad:transactions.read'])
    expect(info.extra?.profileId).toBe('analyst')
    expect(info.extra?.jkt).toBeUndefined() // bearer baseline (M2)
    // expiresAt is seconds since epoch, roughly now + 1h.
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('throws InvalidTokenError for an unknown token', async () => {
    const provider = makeProvider()
    await expect(provider.verifyAccessToken('never-issued')).rejects.toThrow(InvalidTokenError)
  })

  it('throws InvalidTokenError for an expired access token (store filters by real time)', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)
    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)
    const grantId = store.listGrants()[0].grantId // exactly one grant in this test

    // Insert a same-grant access token already past its expiry.
    const raw = 'already-expired-access-token'
    store.putToken({
      tokenHash: sha256hex(raw),
      kind: 'access',
      grantId,
      jkt: undefined,
      expiresAt: Date.now() - 1000,
      createdAt: new Date().toISOString(),
    })
    await expect(provider.verifyAccessToken(raw)).rejects.toThrow(InvalidTokenError)
    // Sanity: the real token still verifies (isolates the expiry as the cause).
    expect((await provider.verifyAccessToken(tokens.access_token)).extra?.profileId).toBe('analyst')
  })

  it('rejects a refresh token presented as an access token', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)
    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)

    await expect(provider.verifyAccessToken(tokens.refresh_token!)).rejects.toThrow(InvalidTokenError)
  })
})

describe('exchangeRefreshToken() — rotation, scope re-mint from grant', () => {
  it('rotates: the old refresh token is dead, a new access + refresh pair is issued', async () => {
    const provider = makeProvider({ requestConsent: approve('analyst') })
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)
    const first = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)

    const second = await provider.exchangeRefreshToken(client, first.refresh_token!)
    expect(second.access_token).toBeTruthy()
    expect(second.refresh_token).toBeTruthy()
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(second.scope).toBe('clad:accounts.read clad:transactions.read')

    // Old refresh is invalidated; new access token works.
    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow(InvalidGrantError)
    expect((await provider.verifyAccessToken(second.access_token)).extra?.profileId).toBe('analyst')
  })

  it('ignores a client-supplied scopes argument — re-mints from the grant only', async () => {
    const provider = makeProvider({ requestConsent: approve('analyst') })
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)
    const first = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)

    const rotated = await provider.exchangeRefreshToken(client, first.refresh_token!, [
      'clad:actions.request',
      'clad:audit.read',
    ])
    // The bogus wider scope request is ignored; the grant scope stands.
    expect(rotated.scope).toBe('clad:accounts.read clad:transactions.read')
  })

  it('rejects an unknown / already-rotated refresh token', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    await expect(provider.exchangeRefreshToken(client, 'never-issued')).rejects.toThrow(InvalidGrantError)
  })
})

describe('revokeToken() — deletion makes the next verify reject (acceptance #3)', () => {
  it('revoking an access token makes verifyAccessToken throw on the very next call', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)
    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)

    // Works before revocation.
    await provider.verifyAccessToken(tokens.access_token)
    await provider.revokeToken(client, { token: tokens.access_token })
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError)
  })

  it('does NOT revoke a token that belongs to a different client (RFC 7009 silent no-op)', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    const { code, verifier } = await authorizeToCode(provider, client)
    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT)

    const otherClient = await registerPublicClient(provider)
    await provider.revokeToken(otherClient, { token: tokens.access_token })
    // Still valid — a client cannot revoke another client's token.
    expect((await provider.verifyAccessToken(tokens.access_token)).extra?.profileId).toBe('analyst')
  })

  it('silently succeeds for an unknown token', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    await expect(provider.revokeToken(client, { token: 'never-issued' })).resolves.toBeUndefined()
  })
})

describe('authenticateTokenRequestClient() — confidential secret verification (landmine #1)', () => {
  it('a public client authenticates by PKCE alone (no secret required)', async () => {
    const provider = makeProvider()
    const client = await registerPublicClient(provider)
    expect(provider.authenticateTokenRequestClient(client.client_id, undefined)).toBe(true)
  })

  it('a confidential client requires the correct secret (constant-time compare)', async () => {
    const provider = makeProvider()
    const conf = await provider.clientsStore.registerClient!({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
      client_secret: 'the-real-secret',
      client_secret_expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
    expect(provider.authenticateTokenRequestClient(conf.client_id, 'the-real-secret')).toBe(true)
    expect(provider.authenticateTokenRequestClient(conf.client_id, 'wrong-secret')).toBe(false)
    expect(provider.authenticateTokenRequestClient(conf.client_id, undefined)).toBe(false)
  })

  it('rejects an unknown client and an expired secret', async () => {
    const provider = makeProvider()
    expect(provider.authenticateTokenRequestClient('unknown-client', 'x')).toBe(false)

    const expired = await provider.clientsStore.registerClient!({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
      client_secret: 'expired-secret',
      client_secret_expires_at: Math.floor(Date.now() / 1000) - 3600,
    })
    expect(provider.authenticateTokenRequestClient(expired.client_id, 'expired-secret')).toBe(false)
  })
})
