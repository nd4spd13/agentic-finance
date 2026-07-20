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
      // WS4 §5 scope-label coverage: gives this profile all four CLAD_SCOPES
      // (accounts, transactions, spending, audit) so the render test below
      // can assert every SCOPE_LABELS entry actually appears on the page,
      // not just the three the original fixture happened to mint.
      description: 'action-bearing spender',
      permissions: {
        accounts: { visible: ['checking'], balance: true },
        transactions: { read: true },
        spending: {},
        audit: {},
      },
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

/**
 * v0.7.1 fix #5: `POST /authorize/decision` responds 200 with a Clad-branded
 * interstitial page instead of a raw 302 — the final redirect URL (code or
 * error, unchanged) is embedded in a `window.location.replace(...)` call
 * rather than a `Location` header. Pulls it back out for assertions.
 */
function extractInterstitialRedirectUrl(html: string): string {
  const match = /window\.location\.replace\("([^"]*)"\)/.exec(html)
  expect(match).toBeTruthy()
  return match![1]
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
    // WS4 §5: every one of the four CLAD_SCOPES entries has a human-readable
    // SCOPE_LABELS entry, proven end-to-end through the real rendered page
    // (not just a lookup-table unit check) — `spender` above mints all four.
    expect(html).toContain('Read account balances')
    expect(html).toContain('Read transactions')
    expect(html).toContain('Request spending actions')
    expect(html).toContain('Read the audit log')
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
  it('valid CSRF token + state + eligible profile -> 200 interstitial embedding redirect_uri with code + state, and the client is bound', async () => {
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

    expect(res.status).toBe(200)
    const html = await res.text()
    const redirectUrl = extractInterstitialRedirectUrl(html)
    const location = new URL(redirectUrl)
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
    const html = await res.text()
    const code = new URL(extractInterstitialRedirectUrl(html)).searchParams.get('code')!
    const stored = store.getAuthCode(code)
    expect(stored?.codeChallenge).toBe('test-challenge')
    expect(stored?.redirectUri).toBe(REDIRECT)
  })

  it('rejects a profile the trust assessment did not deem eligible -> access_denied interstitial, no grant', async () => {
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
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(new URL(extractInterstitialRedirectUrl(html)).searchParams.get('error')).toBe('access_denied')
    expect(store.getClient(client.client_id)?.boundProfileId).toBeUndefined()
  })
})

describe('POST /authorize/decision — deny', () => {
  it('200 interstitial embedding error=access_denied and binds/creates nothing', async () => {
    const { app, client } = buildTestApp()
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    const res = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'deny',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Denied')
    const location = new URL(extractInterstitialRedirectUrl(html))
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
    expect(first.status).toBe(200)

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
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(new URL(extractInterstitialRedirectUrl(html)).searchParams.get('code')).toBeTruthy()
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
    // Fix #2: this second render is now LOCKED to 'analyst' (the existing
    // binding) — posting 'analyst' is exactly what the locked form submits.
    const second = await renderPage()
    expect(second.html).toContain('previously approved as')
    const res = await decide({
      request_id: second.requestId,
      csrf_token: second.csrfToken,
      state: params.state as string,
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(new URL(extractInterstitialRedirectUrl(html)).searchParams.get('code')).toBeTruthy()
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
      // The rendered form's radio for 'spender' is disabled (fix #2 lock), but
      // the server-side set-once check is what actually matters — post it
      // directly to prove the refusal is enforced server-side, not merely
      // client-side by the disabled attribute.
      decision: 'approve',
      profile_id: 'spender', // different from the already-bound 'analyst'
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(new URL(extractInterstitialRedirectUrl(html)).searchParams.get('error')).toBe('access_denied')
    // The binding is untouched — still 'analyst', never rebound to 'spender'.
    expect(store.getClient(client.client_id)?.boundProfileId).toBe('analyst')
  })
})

describe('v0.7.1 fix #2 — consent page honors an existing binding', () => {
  it('a client with an existing (eligible) binding renders that profile preselected and LOCKED; other profiles stay visible but disabled', async () => {
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

    const { html } = await renderPage()
    expect(html).toContain('previously approved as')
    expect(html).toContain('Revoke it in')

    const analystInput = /<input type="radio" name="profile_id" value="analyst"([^>]*)>/.exec(html)?.[1] ?? ''
    expect(analystInput).toContain('checked')
    expect(analystInput).not.toContain('disabled')

    const spenderInput = /<input type="radio" name="profile_id" value="spender"([^>]*)>/.exec(html)?.[1] ?? ''
    expect(spenderInput).toContain('disabled')
    expect(spenderInput).not.toContain(' checked')
  })

  it('a bound profile that is no longer eligible renders a dead-end message instead of an error redirect', async () => {
    const { app, client } = buildTestApp()
    await listen(app)
    // Simulate a policy edit that removed this client's bound profile from
    // eligibility: bind directly at the store level to a profile outside
    // ASSESSMENT.eligibleProfiles (['analyst', 'spender']).
    store.bindClientProfile(client.client_id, 'ghost-profile')

    const res = await fetch(`${baseUrl}/test-authorize`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('ghost-profile')
    expect(html.toLowerCase()).toContain('revoke')
    // No form is rendered — there is no valid choice this page could submit.
    expect(html).not.toContain('<form')
  })
})

describe('v0.7.1 fix #3 — stale consent pages self-expire', () => {
  it('a new authorize for the same client supersedes the older pending request: the old requestId 404s, the new one is approvable', async () => {
    const { app } = buildTestApp()
    await listen(app)

    const first = await renderPage()
    const second = await renderPage() // same client -> supersedes `first`

    const oldDecision = await decide({
      request_id: first.requestId,
      csrf_token: first.csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(oldDecision.status).toBe(404)

    const newDecision = await decide({
      request_id: second.requestId,
      csrf_token: second.csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(newDecision.status).toBe(200)
    const html = await newDecision.text()
    expect(html).toContain('Approved')
  })

  it('the rendered page embeds a poll script targeting /authorize/pending-status with its own state', async () => {
    const { app } = buildTestApp()
    await listen(app)
    const { html } = await renderPage()

    expect(html).toContain('/authorize/pending-status')
    expect(html).toContain('state-abc')
    expect(html).toContain('superseded by a newer one')
  })

  it('GET /authorize/pending-status reports pending for a live request and gone for an unknown one (and when state is omitted)', async () => {
    const { app } = buildTestApp()
    await listen(app)
    await renderPage() // state fixed to 'state-abc' by buildTestApp's params

    const live = await fetch(`${baseUrl}/authorize/pending-status?state=state-abc`)
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ status: 'pending' })

    const unknown = await fetch(`${baseUrl}/authorize/pending-status?state=never-issued`)
    expect(await unknown.json()).toEqual({ status: 'gone' })

    const missing = await fetch(`${baseUrl}/authorize/pending-status`)
    expect(await missing.json()).toEqual({ status: 'gone' })
  })

  it('GET /authorize/pending-status flips to gone once a client\'s request is superseded by a newer authorize', async () => {
    const trust = new LocalConsentTrustProvider(POLICY, mintScopesForProfile, scopeSensitivity)
    const { consentFn, decisionRouter } = createHttpConsent({ store, trust, policy: POLICY })
    const client = registerClient()
    let state = 'poll-state-old'

    const app = express()
    app.get('/test-authorize', (req, res) => {
      const params: AuthorizationParams = { codeChallenge: 'c', redirectUri: REDIRECT, state }
      void consentFn(consentRequestFor(client), { res, client, params, assessment: ASSESSMENT })
    })
    app.use(decisionRouter)
    await listen(app)

    await renderPage() // pending under state 'poll-state-old'
    expect(await (await fetch(`${baseUrl}/authorize/pending-status?state=poll-state-old`)).json()).toEqual({
      status: 'pending',
    })

    state = 'poll-state-new'
    await renderPage() // same client -> supersedes the 'poll-state-old' entry

    expect(await (await fetch(`${baseUrl}/authorize/pending-status?state=poll-state-old`)).json()).toEqual({
      status: 'gone',
    })
    expect(await (await fetch(`${baseUrl}/authorize/pending-status?state=poll-state-new`)).json()).toEqual({
      status: 'pending',
    })
  })
})

describe('v0.7.1 fix #4 — deny sticks (cooldown)', () => {
  it('a retry within the cooldown window gets an IMMEDIATE access_denied redirect — no consent screen is rendered', async () => {
    let t = Date.now()
    const { app } = buildTestApp({ now: () => t })
    await listen(app)

    const first = await renderPage()
    const denyRes = await decide({
      request_id: first.requestId,
      csrf_token: first.csrfToken,
      state: 'state-abc',
      decision: 'deny',
    })
    expect(denyRes.status).toBe(200)

    t += 1_000 // 1s later, well within the 90s cooldown
    const retry = await fetch(`${baseUrl}/test-authorize`, { redirect: 'manual' })
    expect(retry.status).toBe(302)
    const location = new URL(retry.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('access_denied')
  })

  it('after the cooldown window elapses, the consent screen renders normally again', async () => {
    let t = Date.now()
    const { app } = buildTestApp({ now: () => t })
    await listen(app)

    const first = await renderPage()
    await decide({
      request_id: first.requestId,
      csrf_token: first.csrfToken,
      state: 'state-abc',
      decision: 'deny',
    })

    t += 91_000 // just past DENY_COOLDOWN_MS (90s)
    const retry = await fetch(`${baseUrl}/test-authorize`)
    expect(retry.status).toBe(200)
    const html = await retry.text()
    expect(html).toContain('Choose which profile')
  })

  it('an approve clears the deny cooldown for that client — a fresh authorize right after is not gated', async () => {
    let t = Date.now()
    const { app, client } = buildTestApp({ now: () => t })
    await listen(app)

    const first = await renderPage()
    await decide({
      request_id: first.requestId,
      csrf_token: first.csrfToken,
      state: 'state-abc',
      decision: 'deny',
    })

    t += 91_000 // past cooldown — a fresh consent screen can render again
    const second = await renderPage()
    const approveRes = await decide({
      request_id: second.requestId,
      csrf_token: second.csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(approveRes.status).toBe(200)
    expect(store.getClient(client.client_id)?.boundProfileId).toBe('analyst')

    // Immediately after the approve (same clock tick), the client is bound —
    // a fresh authorize renders the (locked) consent page, not an
    // access_denied redirect, proving the earlier deny entry was cleared.
    const third = await fetch(`${baseUrl}/test-authorize`, { redirect: 'manual' })
    expect(third.status).toBe(200)
  })
})

describe('v0.7.1 fix #5 — decision-result interstitial', () => {
  it('approve: 200 html containing the exact redirect URL once, no-referrer + no-store headers, and a replay still 404s', async () => {
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
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/html/)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const html = await res.text()
    expect(html).toContain('Approved')
    const redirectUrl = extractInterstitialRedirectUrl(html)
    const url = new URL(redirectUrl)
    expect(url.origin + url.pathname).toBe(REDIRECT)
    expect(url.searchParams.get('code')).toBeTruthy()
    expect(url.searchParams.get('state')).toBe('state-abc')
    // The visible fallback link carries the SAME URL too.
    expect(html).toContain(`href="${url.href.replace(/&/g, '&amp;')}"`)

    // Single-use: the code was minted exactly once — replaying the SAME
    // decision request 404s rather than minting (or returning) a second one.
    const replay = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'approve',
      profile_id: 'analyst',
    })
    expect(replay.status).toBe(404)
  })

  it('deny: 200 html containing the exact access_denied redirect URL, with the same security headers', async () => {
    const { app } = buildTestApp()
    await listen(app)
    const { requestId, csrfToken } = await renderPage()

    const res = await decide({
      request_id: requestId,
      csrf_token: csrfToken,
      state: 'state-abc',
      decision: 'deny',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const html = await res.text()
    expect(html).toContain('Denied')
    const url = new URL(extractInterstitialRedirectUrl(html))
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('state')).toBe('state-abc')
  })
})
