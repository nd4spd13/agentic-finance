/**
 * D5.3 WS2 S4-S6 integration coverage: the full OAuth 2.1 authorization + token
 * flow driven over the REAL Express app (`buildHttpApp` via `startHttpServer`)
 * with a REAL HTTP client and a REAL, temp-file `SqliteGrantStore` — no mock at
 * the transport boundary, matching every other `mcp-server` integration suite.
 *
 * Covers (WS2 §9 / TEST-PLAN):
 *  - `/register` (RFC 7591 DCR) round-trips (public + confidential).
 *  - Full `register -> authorize (fake consent) -> token -> Bearer /mcp` happy
 *    path over S256 PKCE, ending in a real `tools/call`.
 *  - Wrong PKCE verifier rejected; authorization code single-use.
 *  - Consent deny-by-default -> `access_denied` error redirect, no token.
 *  - Confidential-client secret verification (correct -> issue; wrong/missing
 *    -> `invalid_client`); public client authenticated by PKCE alone.
 *  - `/mcp` 401 without a token, with a `WWW-Authenticate` header pointing at
 *    the protected-resource-metadata URL.
 *  - Revocation -> the next `/mcp` request 401s immediately.
 *
 * D5.3 WS4 S3 addition: the REAL interactive consent screen
 * (`../../src/oauth/consent-http.ts`) driven over this SAME real-app stack —
 * `GET /authorize` renders HTML (not a redirect) and `POST /authorize/decision`
 * completes the flow, proving `CladOAuthProvider.authorize()`'s
 * `res.headersSent` short-circuit (`provider.ts`) and `consent-http.ts`'s
 * `finalizeApprovedAuthorization` reuse work end-to-end through the real
 * Express app, not just against a fake `ConsentFn`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import http, { type IncomingHttpHeaders } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  AuditLogger,
  ApprovalQueue,
  DummyDataProvider,
  SqliteGrantStore,
  LocalConsentTrustProvider,
  type PolicyConfig,
} from '@clad/core'
import { startHttpServer, type HttpServerHandle } from '../../src/http-transport.js'
import { CladOAuthProvider } from '../../src/oauth/provider.js'
import { mintScopesForProfile, scopeSensitivity } from '../../src/oauth/scope-minter.js'
import { denyingConsent, type ConsentFn } from '../../src/oauth/consent.js'
import { createHttpConsent } from '../../src/oauth/consent-http.js'
import type { ServerResources } from '../../src/server-core.js'

const POLICY: PolicyConfig = {
  agents: {
    'test-agent': {
      description: 'OAuth flow test agent',
      permissions: {
        accounts: { visible: ['checking'], balance: true },
        transactions: { read: true },
      },
    },
  },
}

const SECRET_PASSPHRASE = 'oauth-flow-test-passphrase-do-not-leak'
const REDIRECT = 'https://example.com/callback'

let dir: string
let store: SqliteGrantStore
let handle: HttpServerHandle | undefined
let clients: Client[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-oauth-flow-'))
  store = new SqliteGrantStore({ dbPath: join(dir, 'grants.sqlite'), passphrase: SECRET_PASSPHRASE })
})

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  clients = []
  if (handle) {
    await handle.close()
    handle = undefined
  }
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Auto-approve consent binding to the given profile (the WS4 seam, faked). */
const approve = (profileId: string): ConsentFn => async () => ({ approved: true, profileId, dpopBound: false })

function oauthResources(consent: ConsentFn = approve('test-agent')): ServerResources {
  const oauth = new CladOAuthProvider({
    store,
    policy: POLICY,
    trust: new LocalConsentTrustProvider(POLICY, mintScopesForProfile, scopeSensitivity),
    requestConsent: consent,
  })
  return {
    agentId: 'test-agent',
    authRequired: true,
    policy: POLICY,
    provider: new DummyDataProvider(),
    auditLogger: new AuditLogger(':memory:'),
    approvalQueue: new ApprovalQueue(':memory:'),
    oauth,
  }
}

/** Builds `ServerResources` wired with the REAL WS4 S3 consent implementation (`consent-http.ts`) instead of a fake `ConsentFn`. */
function realConsentResources(): ServerResources {
  const trust = new LocalConsentTrustProvider(POLICY, mintScopesForProfile, scopeSensitivity)
  const { consentFn, decisionRouter } = createHttpConsent({ store, trust, policy: POLICY })
  const oauth = new CladOAuthProvider({ store, policy: POLICY, trust, requestConsent: consentFn })
  return {
    agentId: 'test-agent',
    authRequired: true,
    policy: POLICY,
    provider: new DummyDataProvider(),
    auditLogger: new AuditLogger(':memory:'),
    approvalQueue: new ApprovalQueue(':memory:'),
    oauth,
    oauthConsentRouter: decisionRouter,
  }
}

/** Parses the `request_id` and `csrf_token` hidden fields out of a rendered consent page. */
function parseConsentPage(html: string): { requestId: string; csrfToken: string } {
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1]
  const csrfToken = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1]
  if (!requestId || !csrfToken) throw new Error('consent page did not render the expected hidden fields')
  return { requestId, csrfToken }
}

/**
 * v0.7.1 fix #5: `POST /authorize/decision` responds 200 with an interstitial
 * page that `window.location.replace()`s to the final redirect URL, instead
 * of a raw `302`/`Location` header. Pulls that URL back out for assertions.
 */
function parseInterstitialRedirect(html: string): URL {
  const match = /window\.location\.replace\("([^"]*)"\)/.exec(html)
  if (!match) throw new Error('decision interstitial did not embed a redirect URL')
  return new URL(match[1])
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function registerClient(
  port: number,
  body: Record<string, unknown> = { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}

/** Raw `node:http` GET so we can read a cross-origin 302 Location without fetch's opaque-redirect handling. */
function rawRequest(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') })
        )
      }
    )
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/** Drives GET /authorize and returns the `code` from the 302 redirect (throws on an error redirect). */
async function authorizeForCode(
  port: number,
  clientId: string,
  challenge: string,
  state = 'state-xyz'
): Promise<string> {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString()
  const res = await rawRequest(port, `/authorize?${query}`)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.location!)
  const err = location.searchParams.get('error')
  if (err) throw new Error(`authorize error redirect: ${err}`)
  return location.searchParams.get('code')!
}

async function postToken(
  port: number,
  params: Record<string, string>
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* non-JSON body left as text */
  }
  return { status: res.status, json, text }
}

async function connectMcp(port: number, bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  })
  const c = new Client({ name: 'oauth-flow-test', version: '0.0.0' }, { capabilities: {} })
  await c.connect(transport)
  clients.push(c)
  return c
}

describe('POST /register (RFC 7591 DCR)', () => {
  it('registers a public client and the SAME store the server opened reads it back', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const json = await registerClient(handle.port, {
      redirect_uris: [REDIRECT],
      client_name: 'Integration Test Client',
      token_endpoint_auth_method: 'none',
    })

    expect(json.client_id).toBeTruthy()
    expect(json.client_secret).toBeUndefined()
    const persisted = store.getClient(json.client_id as string)
    expect(persisted?.clientName).toBe('Integration Test Client')
    expect(persisted?.redirectUris).toEqual([REDIRECT])
  })

  it('registers a confidential client and returns the secret once, never on a later read', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const json = await registerClient(handle.port, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    })

    expect(typeof json.client_secret).toBe('string')
    expect(store.getClient(json.client_id as string)).toBeDefined()
    // getClient never surfaces the secret.
    const read = await new CladOAuthProvider({
      store,
      policy: POLICY,
      trust: new LocalConsentTrustProvider(POLICY, mintScopesForProfile, scopeSensitivity),
      requestConsent: denyingConsent,
    }).clientsStore.getClient(json.client_id as string)
    expect(read?.client_secret).toBeUndefined()
  })
})

describe('full authorization-code + PKCE round trip over HTTP', () => {
  it('register -> authorize -> token -> Bearer /mcp tools/call succeeds', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const { verifier, challenge } = pkce()

    const code = await authorizeForCode(handle.port, client.client_id as string, challenge)
    const { status, json } = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: client.client_id as string,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    })

    expect(status).toBe(200)
    expect(json.token_type).toBe('Bearer')
    expect(json.access_token).toBeTruthy()
    expect(json.refresh_token).toBeTruthy()
    expect(json.scope).toBe('clad:accounts.read clad:transactions.read')

    // The minted access token authenticates a real MCP session.
    const mcp = await connectMcp(handle.port, json.access_token as string)
    const result = await mcp.callTool({ name: 'clad_get_balances', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('acc_checking_001')
    expect(text).not.toContain('acc_savings_001') // test-agent: checking only
  })

  it('rejects a wrong PKCE code_verifier at /token (invalid_grant)', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const { challenge } = pkce()
    const code = await authorizeForCode(handle.port, client.client_id as string, challenge)

    const { status, json } = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: client.client_id as string,
      code,
      code_verifier: 'the-wrong-verifier',
      redirect_uri: REDIRECT,
    })
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_grant')
  })

  it('is single-use: replaying a redeemed code fails with invalid_grant', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const { verifier, challenge } = pkce()
    const code = await authorizeForCode(handle.port, client.client_id as string, challenge)

    const first = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: client.client_id as string,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    })
    expect(first.status).toBe(200)

    const replay = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: client.client_id as string,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    })
    expect(replay.status).toBe(400)
    expect(replay.json.error).toBe('invalid_grant')
  })
})

describe('refresh rotation over HTTP', () => {
  it('exchanges a refresh token for a new pair and invalidates the old refresh', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const { verifier, challenge } = pkce()
    const code = await authorizeForCode(handle.port, client.client_id as string, challenge)
    const first = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: client.client_id as string,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    })

    const rotated = await postToken(handle.port, {
      grant_type: 'refresh_token',
      client_id: client.client_id as string,
      refresh_token: first.json.refresh_token as string,
    })
    expect(rotated.status).toBe(200)
    expect(rotated.json.refresh_token).not.toBe(first.json.refresh_token)

    // The old refresh token is now dead.
    const reused = await postToken(handle.port, {
      grant_type: 'refresh_token',
      client_id: client.client_id as string,
      refresh_token: first.json.refresh_token as string,
    })
    expect(reused.status).toBe(400)
    expect(reused.json.error).toBe('invalid_grant')
  })
})

describe('consent deny-by-default', () => {
  it('GET /authorize redirects with error=access_denied (never mints a code) and issues no token', async () => {
    handle = await startHttpServer(oauthResources(denyingConsent), { port: 0 })
    const client = await registerClient(handle.port)
    const { challenge } = pkce()

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'deny-state',
    }).toString()
    const res = await rawRequest(handle.port, `/authorize?${query}`)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.location!)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('deny-state')
    expect(location.searchParams.get('code')).toBeNull()
    expect(res.body).not.toContain(SECRET_PASSPHRASE)
  })
})

describe('confidential-client secret verification at /token (landmine #1)', () => {
  it('issues tokens with the correct secret, rejects a wrong or missing one (invalid_client)', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    })
    const clientId = client.client_id as string
    const clientSecret = client.client_secret as string

    // Correct secret -> issued.
    const { verifier, challenge } = pkce()
    const code = await authorizeForCode(handle.port, clientId, challenge)
    const ok = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    })
    expect(ok.status).toBe(200)
    expect(ok.json.access_token).toBeTruthy()

    // Wrong secret -> 401 invalid_client, and the real secret must not leak.
    const pk2 = pkce()
    const code2 = await authorizeForCode(handle.port, clientId, pk2.challenge)
    const bad = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: 'not-the-secret',
      code: code2,
      code_verifier: pk2.verifier,
      redirect_uri: REDIRECT,
    })
    expect(bad.status).toBe(401)
    expect(bad.json.error).toBe('invalid_client')
    expect(bad.text).not.toContain(clientSecret)

    // Missing secret for a confidential client -> 401 invalid_client.
    const pk3 = pkce()
    const code3 = await authorizeForCode(handle.port, clientId, pk3.challenge)
    const missing = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: code3,
      code_verifier: pk3.verifier,
      redirect_uri: REDIRECT,
    })
    expect(missing.status).toBe(401)
    expect(missing.json.error).toBe('invalid_client')
  })
})

describe('/mcp bearer enforcement', () => {
  it('401s an /mcp request with no token, naming the protected-resource-metadata URL', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const res = await rawRequest(handle.port, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })

    expect(res.status).toBe(401)
    const wwwAuth = res.headers['www-authenticate']
    expect(wwwAuth).toContain('Bearer')
    expect(wwwAuth).toContain('/.well-known/oauth-protected-resource/mcp')
  })

  it('revocation is immediate: after /revoke, the next /mcp call 401s', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const { verifier, challenge } = pkce()
    const code = await authorizeForCode(handle.port, client.client_id as string, challenge)
    const { json } = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: client.client_id as string,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    })
    const accessToken = json.access_token as string

    // Works first.
    const mcp = await connectMcp(handle.port, accessToken)
    await mcp.callTool({ name: 'clad_get_balances', arguments: {} })

    // Revoke, then a fresh /mcp initialize with the same token must 401.
    const revoke = await fetch(`http://127.0.0.1:${handle.port}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.client_id as string, token: accessToken }).toString(),
    })
    expect(revoke.status).toBe(200)

    const after = await rawRequest(handle.port, '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(after.status).toBe(401)
  })
})

describe('real interactive consent screen (D5.3 WS4 S3)', () => {
  it('GET /authorize renders HTML (not a redirect), listing the client and its profiles, no secrets', async () => {
    handle = await startHttpServer(realConsentResources(), { port: 0 })
    const client = await registerClient(handle.port, {
      redirect_uris: [REDIRECT],
      client_name: 'Interactive Test Client',
      token_endpoint_auth_method: 'none',
    })
    const { challenge } = pkce()
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'render-state',
    }).toString()

    const res = await rawRequest(handle.port, `/authorize?${query}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('html')
    expect(res.body).toContain('Interactive Test Client')
    expect(res.body).toContain('test-agent')
    expect(res.body).not.toContain(SECRET_PASSPHRASE)
    const { requestId, csrfToken } = parseConsentPage(res.body)
    expect(requestId).toBeTruthy()
    expect(csrfToken).toBeTruthy()
  })

  it('register -> authorize (render) -> decide (approve) -> token -> Bearer /mcp tools/call succeeds', async () => {
    handle = await startHttpServer(realConsentResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const { verifier, challenge } = pkce()

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'approve-state',
    }).toString()
    const rendered = await rawRequest(handle.port, `/authorize?${query}`)
    expect(rendered.status).toBe(200)
    const { requestId, csrfToken } = parseConsentPage(rendered.body)

    const decision = await rawRequest(handle.port, '/authorize/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: requestId,
        csrf_token: csrfToken,
        state: 'approve-state',
        decision: 'approve',
        profile_id: 'test-agent',
      }).toString(),
    })
    // Fix #5: 200 interstitial (not a raw 302) — the redirect URL is embedded
    // client-side, unchanged from what the old 302's Location header carried.
    expect(decision.status).toBe(200)
    const location = parseInterstitialRedirect(decision.body)
    expect(location.searchParams.get('state')).toBe('approve-state')
    const code = location.searchParams.get('code')
    expect(code).toBeTruthy()

    const { status, json } = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: client.client_id as string,
      code: code!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    })
    expect(status).toBe(200)
    expect(json.token_type).toBe('Bearer')
    expect(json.access_token).toBeTruthy()

    const mcp = await connectMcp(handle.port, json.access_token as string)
    const result = await mcp.callTool({ name: 'clad_get_balances', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('acc_checking_001')
  })

  it('deny -> redirects with error=access_denied, no code, no token', async () => {
    handle = await startHttpServer(realConsentResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const { challenge } = pkce()

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'deny-state',
    }).toString()
    const rendered = await rawRequest(handle.port, `/authorize?${query}`)
    const { requestId, csrfToken } = parseConsentPage(rendered.body)

    const decision = await rawRequest(handle.port, '/authorize/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: requestId,
        csrf_token: csrfToken,
        state: 'deny-state',
        decision: 'deny',
      }).toString(),
    })
    // Fix #5: 200 interstitial embedding the access_denied redirect.
    expect(decision.status).toBe(200)
    const location = parseInterstitialRedirect(decision.body)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('code')).toBeNull()
  })

  it('rejects a decision with a missing/invalid CSRF token (403), never mints a code', async () => {
    handle = await startHttpServer(realConsentResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const { challenge } = pkce()

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'csrf-state',
    }).toString()
    const rendered = await rawRequest(handle.port, `/authorize?${query}`)
    const { requestId } = parseConsentPage(rendered.body)

    const decision = await rawRequest(handle.port, '/authorize/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: requestId,
        csrf_token: 'forged-token',
        state: 'csrf-state',
        decision: 'approve',
        profile_id: 'test-agent',
      }).toString(),
    })
    expect(decision.status).toBe(403)
  })

  it('set-once bind: a second authorize + approve for the SAME client reuses the bound profile end-to-end', async () => {
    handle = await startHttpServer(realConsentResources(), { port: 0 })
    const client = await registerClient(handle.port)

    async function authorizeAndApprove(state: string): Promise<{ status: number; location: URL }> {
      const { challenge } = pkce()
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString()
      const rendered = await rawRequest(handle!.port, `/authorize?${query}`)
      const { requestId, csrfToken } = parseConsentPage(rendered.body)
      const decision = await rawRequest(handle!.port, '/authorize/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_id: requestId,
          csrf_token: csrfToken,
          state,
          decision: 'approve',
          profile_id: 'test-agent',
        }).toString(),
      })
      // Fix #5: 200 interstitial, not a raw 302 — extract the embedded redirect.
      return { status: decision.status, location: parseInterstitialRedirect(decision.body) }
    }

    const first = await authorizeAndApprove('bind-state-1')
    expect(first.status).toBe(200)
    expect(first.location.searchParams.get('code')).toBeTruthy()
    expect(store.getClient(client.client_id as string)?.boundProfileId).toBe('test-agent')

    // A different `requestedProfileHint` never reaches the wire (WS2's
    // `authorize()` never trusts a client-supplied hint as identity — it is
    // always `undefined` on the built `ConsentRequest`); what CAN vary here is
    // the human's own choice on the SECOND consent page, which must still
    // resolve to the already-bound profile.
    const second = await authorizeAndApprove('bind-state-2')
    expect(second.status).toBe(200)
    expect(second.location.searchParams.get('code')).toBeTruthy()
    expect(second.location.searchParams.get('error')).toBeNull()
    expect(store.getClient(client.client_id as string)?.boundProfileId).toBe('test-agent')
  })
})
