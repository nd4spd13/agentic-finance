/**
 * D5.3 WS2 S3 coverage: `CladOAuthProvider` (`../../src/oauth/provider.ts`).
 *
 * Two halves, matching the file's own "S2-S3 ONLY" scope split:
 *  1. `clientsStore` — REAL, backed by a temp-file `SqliteGrantStore` (no
 *     mocking the store; same "real SDK/real store, no mock at the boundary"
 *     policy the rest of this package's tests follow).
 *  2. Every other `OAuthServerProvider` method — a Wave-4 seam that MUST
 *     throw `OAuthFlowNotImplementedError`, never partially implement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { SqliteGrantStore } from '@clad/core'
import { CladOAuthProvider, OAuthFlowNotImplementedError } from '../../src/oauth/provider.js'

let dir: string
let store: SqliteGrantStore
let provider: CladOAuthProvider

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-oauth-provider-'))
  store = new SqliteGrantStore({ dbPath: join(dir, 'grants.sqlite'), passphrase: 'provider-test-passphrase' })
  provider = new CladOAuthProvider({ store })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('CladOAuthProvider.clientsStore — real RFC 7591 DCR over SqliteGrantStore', () => {
  it('registerClient persists a public client (no secret) and getClient reads it back', async () => {
    const registered = await provider.clientsStore.registerClient!({
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'Public Test Client',
    })

    expect(registered.client_id).toBeTruthy()
    expect(registered.client_secret).toBeUndefined()
    expect(registered.token_endpoint_auth_method).toBe('none')

    const read = await provider.clientsStore.getClient(registered.client_id)
    expect(read).toBeDefined()
    expect(read?.client_id).toBe(registered.client_id)
    expect(read?.redirect_uris).toEqual(['https://example.com/callback'])
    expect(read?.client_name).toBe('Public Test Client')
  })

  it('registerClient persists a confidential client\'s secret encrypted, echoes it ONCE on registration, and NEVER returns it on a later read', async () => {
    const registered = await provider.clientsStore.registerClient!({
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'client_secret_post',
      client_secret: 'sdk-generated-secret-abc123',
      client_secret_expires_at: Math.floor(Date.now() / 1000) + 3600,
    })

    // The registration RESPONSE (RFC 7591) is the one and only place the
    // secret is ever handed back — this mirrors what the SDK's own
    // `clientRegistrationHandler` returns to the caller over HTTP.
    expect(registered.client_secret).toBe('sdk-generated-secret-abc123')
    expect(registered.token_endpoint_auth_method).toBe('client_secret_post')

    const read = await provider.clientsStore.getClient(registered.client_id)
    expect(read).toBeDefined()
    expect(read?.client_secret).toBeUndefined()
    // Confirms the omission isn't a lucky accident of the request object
    // still being empty — the raw secret string is nowhere in the read view.
    expect(JSON.stringify(read)).not.toContain('sdk-generated-secret-abc123')
  })

  it('maps an absent client_secret to token_endpoint_auth_method "none"', async () => {
    const registered = await provider.clientsStore.registerClient!({
      redirect_uris: ['https://example.com/callback'],
    })
    expect(registered.token_endpoint_auth_method).toBe('none')
    const read = await provider.clientsStore.getClient(registered.client_id)
    expect(read?.token_endpoint_auth_method).toBe('none')
  })

  it('maps a present client_secret to token_endpoint_auth_method "client_secret_post" (never client_secret_basic)', async () => {
    const registered = await provider.clientsStore.registerClient!({
      redirect_uris: ['https://example.com/callback'],
      client_secret: 'some-secret',
    })
    expect(registered.token_endpoint_auth_method).toBe('client_secret_post')
  })

  it('getClient returns undefined for an unknown client id', async () => {
    const read = await provider.clientsStore.getClient('nonexistent-client-id')
    expect(read).toBeUndefined()
  })

  it('round-trips through a REOPENED store handle (persisted to disk, not just in-memory)', async () => {
    // Uses its OWN local store/dir — deliberately separate from the shared
    // `beforeEach`/`afterEach` fixture above — so this test's close/reopen
    // dance can't interact with the outer fixture's lifecycle.
    const localDir = mkdtempSync(join(tmpdir(), 'clad-oauth-provider-reopen-'))
    try {
      const dbPath = join(localDir, 'grants.sqlite')
      const firstStore = new SqliteGrantStore({ dbPath, passphrase: 'reopen-test-passphrase' })
      const registered = await new CladOAuthProvider({ store: firstStore }).clientsStore.registerClient!({
        redirect_uris: ['https://example.com/callback'],
        client_name: 'Persisted Client',
      })
      firstStore.close()

      const reopenedStore = new SqliteGrantStore({ dbPath, passphrase: 'reopen-test-passphrase' })
      try {
        const read = await new CladOAuthProvider({ store: reopenedStore }).clientsStore.getClient(
          registered.client_id
        )
        expect(read).toBeDefined()
        expect(read?.client_name).toBe('Persisted Client')
      } finally {
        reopenedStore.close()
      }
    } finally {
      rmSync(localDir, { recursive: true, force: true })
    }
  })
})

describe('CladOAuthProvider — every non-clientsStore flow method is an unimplemented seam (Wave 4)', () => {
  const fakeClient: OAuthClientInformationFull = {
    client_id: 'fake-client-id',
    redirect_uris: ['https://example.com/callback'],
  }

  it('authorize() throws OAuthFlowNotImplementedError', async () => {
    const res = {} as never
    await expect(
      provider.authorize(fakeClient, { codeChallenge: 'abc', redirectUri: 'https://example.com/callback' }, res)
    ).rejects.toThrow(OAuthFlowNotImplementedError)
  })

  it('challengeForAuthorizationCode() throws OAuthFlowNotImplementedError', async () => {
    await expect(provider.challengeForAuthorizationCode(fakeClient, 'some-code')).rejects.toThrow(
      OAuthFlowNotImplementedError
    )
  })

  it('exchangeAuthorizationCode() throws OAuthFlowNotImplementedError', async () => {
    await expect(
      provider.exchangeAuthorizationCode(fakeClient, 'some-code', 'some-verifier')
    ).rejects.toThrow(OAuthFlowNotImplementedError)
  })

  it('exchangeRefreshToken() throws OAuthFlowNotImplementedError', async () => {
    await expect(provider.exchangeRefreshToken(fakeClient, 'some-refresh-token')).rejects.toThrow(
      OAuthFlowNotImplementedError
    )
  })

  it('verifyAccessToken() throws OAuthFlowNotImplementedError', async () => {
    await expect(provider.verifyAccessToken('some-access-token')).rejects.toThrow(OAuthFlowNotImplementedError)
  })

  it('revokeToken() throws OAuthFlowNotImplementedError', async () => {
    await expect(provider.revokeToken(fakeClient, { token: 'some-token' })).rejects.toThrow(
      OAuthFlowNotImplementedError
    )
  })

  it('every thrown error carries the fixed OAUTH_FLOW_NOT_IMPLEMENTED code and NEVER echoes the input token/code/verifier', async () => {
    const secretsUsedInThisTest = ['sekrit-code-99', 'sekrit-verifier-88', 'sekrit-token-77', 'sekrit-refresh-66']

    const errors = await Promise.all([
      provider.challengeForAuthorizationCode(fakeClient, secretsUsedInThisTest[0]).catch((e: unknown) => e),
      provider
        .exchangeAuthorizationCode(fakeClient, secretsUsedInThisTest[0], secretsUsedInThisTest[1])
        .catch((e: unknown) => e),
      provider.exchangeRefreshToken(fakeClient, secretsUsedInThisTest[3]).catch((e: unknown) => e),
      provider.verifyAccessToken(secretsUsedInThisTest[2]).catch((e: unknown) => e),
      provider.revokeToken(fakeClient, { token: secretsUsedInThisTest[2] }).catch((e: unknown) => e),
    ])

    for (const error of errors) {
      expect(error).toBeInstanceOf(OAuthFlowNotImplementedError)
      const err = error as OAuthFlowNotImplementedError
      expect(err.code).toBe('OAUTH_FLOW_NOT_IMPLEMENTED')
      for (const secret of secretsUsedInThisTest) {
        expect(err.message).not.toContain(secret)
      }
    }
  })
})
