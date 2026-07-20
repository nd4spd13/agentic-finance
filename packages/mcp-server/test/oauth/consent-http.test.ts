/**
 * D5.3 WS4 S3 coverage: `createHttpConsent` (`../../src/oauth/consent-http.ts`)
 * in isolation — the real loopback-served consent page + its
 * `POST /authorize/decision` route. Backed by a temp-file `SqliteGrantStore`
 * and a real `LocalConsentTrustProvider` (no mock at the store/trust
 * boundary, matching this package's test policy), driven over a REAL Express
 * app + `node:http` server + `fetch`/raw sockets (no mock at the transport
 * boundary either).
 *
 * The full authorize -> render -> decide -> token round trip through
 * `CladOAuthProvider.authorize()`'s real `res.headersSent` short-circuit
 * lives in `test/oauth/oauth-flow.test.ts` (WS4 S3 section); THIS file
 * isolates `consent-http.ts`'s own contract: rendering content, CSRF/state
 * validation, single-use, expiry, and the set-once bind re-check on approval.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express, { type Express } from 'express'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import { SqliteGrantStore, LocalConsentTrustProvider, type PolicyConfig, type TrustAssessment } from '@clad/core'
import { createHttpConsent, type HttpConsentDeps } from '../../src/oauth/consent-http.js'
import { mintScopesForProfile, scopeSensitivity } from '../../src/oauth/scope-minter.js'
import type { ConsentRequest } from '../../src/oauth/consent.js'

const POLICY: PolicyConfig = {
  agents: {
    analyst: {
      description: 'read-only analyst',
      permissions: { accounts: { visible: ['checking'], balance: true }, transactions: { read: true } },
    },
    spender: {
      description: 'action-bearing spender',
      permissions: { accounts: { visible: ['checking'], balance: true }, spending: {} },
    },
  },
}

const REDIRECT = 'https://example.com/callback'
const SECRET_PASSPHRASE = 'consent-http-test-passphrase-do-not-leak'

let dir: string
let store: SqliteGrantStore
let server: http.Server | undefined
let baseUrl: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-consent-http-'))
  store = new SqliteGrantStore({ dbPath: join(dir, 'grants.sqlite'), passphrase: SECRET_PASSPHRASE })
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function registerClient(name = 'Test Client'): OAuthClientInformationFull {
  const stored = store.registerClient({
    clientName: name,
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: 'none',
  })
  return {
    client_id: stored.clientId,
    client_id_issued_at: stored.clientIdIssuedAt,
    redirect_uris: stored.redirectUris,
    token_endpoint_auth_method: stored.tokenEndpointAuthMethod,
    client_name: stored.clientName,
  }
}

const ASSESSMENT: TrustAssessment = {
  assuranceLevel: 'local-consent',
  eligibleProfiles: ['analyst', 'spender'],
  maxScopeSensitivity: 'low',
}

function consentRequestFor(client: OAuthClientInformationFull): ConsentRequest {
  return {
    clientId: client.client_id,
    clientName: client.client_name,
    requestedProfileHint: undefined,
    availableProfiles: ASSESSMENT.eligibleProfiles,
    scopePreviewByProfile: {
      analyst: mintScopesForProfile(POLICY, 'analyst'),
      spender: mintScopesForProfile(POLICY, 'spender'),
    },
  }
}

/** Wires `consentFn` behind a plain `GET /test-authorize` route (standing in for `CladOAuthProvider.authorize()`, which is covered end-to-end in `oauth-flow.test.ts`) and mounts `decisionRouter`, then starts a real `node:http` server. */
function buildTestApp(deps: Omit<HttpConsentDeps, 'store' | 'trust' | 'policy'> = {}): {
  app: Express
  client: OAuthClientInformationFull
  params: AuthorizationParams
} {
  const trust = new LocalConsentTrustProvider(POLICY, mintScopesForProfile, scopeSensitivity)
  const { consentFn, decisionRouter } = createHttpConsent({ store, trust, policy: POLICY, ...deps })
  const client = registerClient()
  const params: AuthorizationParams = { codeChallenge: 'test-challenge', redirectUri: REDIRECT, state: 'state-abc' }

  const app = express()
  app.get('/test-authorize', (req, res) => {
    void consentFn(consentRequestFor(client), { res, client, params, assessment: ASSESSMENT })
  })
  app.use(decisionRouter)

  return { app, client, params }
}

async function listen(app: Express): Promise<void> {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
}

interface RenderedPage {
  html: string
  requestId: string
  csrfToken: string
}

async function renderPage(): Promise<RenderedPage> {
  const res = await fetch(`${baseUrl}/test-authorize`)
  expect(res.status).toBe(200)
  const html = await res.text()
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1]
  const csrfToken = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1]
  expect(requestId).toBeTruthy()
  expect(csrfToken).toBeTruthy()
  return { html, requestId: requestId!, csrfToken: csrfToken! }
}

function decide(body: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/authorize/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams(body).toString(),
  })
}

describe('consentFn — renders the consent page', () => {
  it('lists every available profile and its scope preview, labels the client name as reported, and leaks no secret', async () => {
    const { app } = buildTestApp()
    await listen(app)
    const { html } = await renderPage()

    expect(html).toContain('Test Client')
    expect(html).toContain('as reported by the client')
    expect(html).toContain('analyst')
    expect(html).toContain('spender')
    expect(html).toContain('Read account balances')
    expect(html).toContain('Read transactions')
    expect(html).toContain('Request spending actions')
    // No token, code, secret, or passphrase has been minted yet at render
    // time — assert none leaked in regardless.
    expect(html).not.toContain(SECRET_PASSPHRASE)
    expect(html.toLowerCase()).not.toContain('client_secret')
  })

  it('HTML-escapes an untrusted, attacker-controlled client name', async () => {
    const trust = new LocalConsentTrustProvider(POLICY, mintScopesForProfile, scopeSensitivity)
    const { consentFn } = createHttpConsent({ store, trust, policy: POLICY })
    const client = registerClient('<script>alert(1)</script>')
    const params: AuthorizationParams = { codeChallenge: 'c', redirectUri: REDIRECT, state: 's' }

    const app = express()
    app.get('/test-authorize', (req, res) => {
      void consentFn(consentRequestFor(client), { res, client, params, assessment: ASSESSMENT })
    })
    await listen(app)

    const res = await fetch(`${baseUrl}/test-authorize`)
    const html = await res.text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('never touches `res` for anything but that ONE render — headersSent is true after the call', async () => {
    const trust = new LocalConsentTrustProvider(POLICY, mintScopesForProfile, scopeSensitivity)
    const { consentFn } = createHttpConsent({ store, trust, policy: POLICY })
    const client = registerClient()
    const params: AuthorizationParams = { codeChallenge: 'c', redirectUri: REDIRECT, state: 's' }

    const app = express()
    let headersSentAfterCall: boolean | undefined
    app.get('/test-authorize', async (req, res) => {
      await consentFn(consentRequestFor(client), { res, client, params, assessment: ASSESSMENT })
      headersSentAfterCall = res.headersSent
    })
    await listen(app)

    await fetch(`${baseUrl}/test-authorize`)
    expect(headersSentAfterCall).toBe(true)
  })
})

describe('POST /authorize/decision — approve', () => {
  it('valid CSRF token + state + eligible profile -> redirects to redirect_uri with code + state, and the client is bound', async () => {
    const { app, client } = buildTestApp()
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    const res = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe(REDIRECT)
    expect(location.searchParams.get('state')).toBe('state-abc')
    expect(location.searchParams.get('code')).toBeTruthy()
    expect(location.searchParams.get('error')).toBeNull()
    expect(store.getClient(client.client_id)?.boundProfileId).toBe('analyst')
  })

  it('the code is redeemable at the grant store level (a real single-use auth code was persisted)', async () => {
    const { app } = buildTestApp()
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    const res = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!
    const stored = store.getAuthCode(code)
    expect(stored?.codeChallenge).toBe('test-challenge')
    expect(stored?.redirectUri).toBe(REDIRECT)
  })

  it('rejects a profile the trust assessment did not deem eligible -> access_denied, no grant', async () => {
    const { app, client } = buildTestApp()
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    const res = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'not-a-real-profile',
    })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
    expect(store.getClient(client.client_id)?.boundProfileId).toBeUndefined()
  })
})

describe('POST /authorize/decision — deny', () => {
  it('redirects with error=access_denied and binds/creates nothing', async () => {
    const { app, client } = buildTestApp()
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    const res = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'deny',
    })
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('state-abc')
    expect(location.searchParams.get('code')).toBeNull()
    expect(store.getClient(client.client_id)?.boundProfileId).toBeUndefined()
  })
})

describe('POST /authorize/decision — CSRF + state protection', () => {
  it('rejects a missing CSRF token (403)', async () => {
    const { app } = buildTestApp()
    await listen(app)
    const { requestId } = await renderPage()

    const res = await decide({ request_id: requestId, state: 'state-abc', decision: 'approve', profile_id: 'analyst' })
    expect(res.status).toBe(403)
  })

  it('rejects a mismatched CSRF token (403)', async () => {
    const { app } = buildTestApp()
    await listen(app)
    const { requestId } = await renderPage()

    const res = await decide({
      request_id: requestId,
      csrf_token: 'totally-not-the-right-token',
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(res.status).toBe(403)
  })

  it('rejects a mismatched state (403) even with a valid CSRF token', async () => {
    const { app } = buildTestApp()
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    const res = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'a-different-state',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(res.status).toBe(403)
  })

  it('rejects a reused (already-decided) request id — single-use (404 on replay)', async () => {
    const { app } = buildTestApp()
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    const first = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(first.status).toBe(302)

    const replay = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(replay.status).toBe(404)
  })

  it('404s an unknown request id', async () => {
    const { app } = buildTestApp()
    await listen(app)

    const res = await decide({
      request_id: 'never-rendered',
      csrf_token: 'whatever',
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(res.status).toBe(404)
  })
})

describe('pending-request expiry', () => {
  it('a decision submitted after the TTL 404s', async () => {
    let now = Date.now()
    const { app } = buildTestApp({ now: () => now, ttlMs: 1000 })
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    now += 5000 // well past the 1s TTL
    const res = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(res.status).toBe(404)
  })

  it('a decision submitted within the TTL still succeeds', async () => {
    let now = Date.now()
    const { app } = buildTestApp({ now: () => now, ttlMs: 60_000 })
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    now += 1000
    const res = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy()
  })
})

describe('set-once bind re-check on approval (acceptance #1, shared with `finalizeApprovedAuthorization`)', () => {
  it('a second authorization for the same client approving the SAME bound profile succeeds', async () => {
    const { app, client, params } = buildTestApp()
    await listen(app)

    const first = await renderPage()
    await decide({
      request_id: first.requestId,
      csrf_token: first.csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(store.getClient(client.client_id)?.boundProfileId).toBe('analyst')

    // Re-authorize the SAME already-bound client, approving the SAME profile.
    const second = await renderPage()
    const res = await decide({
      request_id: second.requestId,
      csrf_token: second.csrfToken,
      state: params.state as string,
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy()
    expect(store.getClient(client.client_id)?.boundProfileId).toBe('analyst')
  })

  it('a second authorization approving a DIFFERENT profile than the bound one is denied (no rebind)', async () => {
    const { app, client } = buildTestApp()
    await listen(app)

    const first = await renderPage()
    await decide({
      request_id: first.requestId,
      csrf_token: first.csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(store.getClient(client.client_id)?.boundProfileId).toBe('analyst')

    const second = await renderPage()
    const res = await decide({
      request_id: second.requestId,
      csrf_token: second.csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'spender', // different from the already-bound 'analyst'
    })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
    // The binding is untouched — still 'analyst', never rebound to 'spender'.
    expect(store.getClient(client.client_id)?.boundProfileId).toBe('analyst')
  })
})
