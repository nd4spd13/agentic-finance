/**
 * D5.3 Wave 7 (M3) coverage: REAL RFC 9449 DPoP proof validation + per-token
 * sender constraint (`../../src/oauth/dpop.ts`, plus the issuance binding in
 * `../../src/oauth/provider.ts` and the `/token` + `/mcp` mounts in
 * `../../src/http-app.ts`).
 *
 * Driven over the REAL Express app (`startHttpServer`) with a REAL, temp-file
 * `SqliteGrantStore` and a SYNTHETIC DPoP client — an ES256 (P-256) keypair
 * that crafts genuine proofs — matching every other mcp-server integration
 * suite (no mock at the transport boundary).
 *
 * Posture under test (parent §10): bearer-baseline, DPoP bound PER-TOKEN, gated
 * by scope, NEVER mandated. So this file proves BOTH halves:
 *  - a DPoP-bound token is enforced on every `/mcp` request (happy path, plus
 *    replay / wrong-key / htu / htm / iat / ath / missing-proof rejections);
 *  - a plain-bearer token is COMPLETELY unaffected.
 *
 * Presentation note (SDK constraint): the SDK's `requireBearerAuth` (mounted
 * ahead of `dpopEnforcement`) only accepts `Authorization: Bearer <token>`, so a
 * DPoP-bound token is carried in the `Bearer` header with the proof in the
 * separate `DPoP` header — NOT RFC 9449's `Authorization: DPoP <token>` scheme.
 * The `ath` binding still ties the proof to the token; only the scheme label
 * differs. See `dpop.ts`'s header and the Wave-7 report.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHash,
  randomBytes,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
  type JsonWebKey,
} from 'node:crypto'
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
import { computeJwkThumbprint } from '../../src/oauth/dpop.js'
import type { ConsentFn } from '../../src/oauth/consent.js'
import type { ServerResources } from '../../src/server-core.js'

// `spender` (spending block present) mints the high-sensitivity
// `clad:actions.request`; `analyst` is read-only. A DPoP-bound client can hold
// the action scope, a bearer one cannot.
const POLICY: PolicyConfig = {
  agents: {
    spender: {
      description: 'action-bearing spender',
      permissions: {
        accounts: { visible: ['checking'], balance: true },
        transactions: { read: true },
        spending: {},
      },
    },
  },
}

const SECRET_PASSPHRASE = 'dpop-test-passphrase-do-not-leak'
const REDIRECT = 'https://example.com/callback'

let dir: string
let store: SqliteGrantStore
let handle: HttpServerHandle | undefined
let clients: Client[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-dpop-'))
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

const approve = (profileId: string): ConsentFn => async () => ({ approved: true, profileId, dpopBound: false })

function oauthResources(consent: ConsentFn = approve('spender')): ServerResources {
  const oauth = new CladOAuthProvider({
    store,
    policy: POLICY,
    trust: new LocalConsentTrustProvider(POLICY, mintScopesForProfile, scopeSensitivity),
    requestConsent: consent,
  })
  return {
    agentId: 'spender',
    authRequired: true,
    policy: POLICY,
    provider: new DummyDataProvider(),
    auditLogger: new AuditLogger(':memory:'),
    approvalQueue: new ApprovalQueue(':memory:'),
    oauth,
  }
}

// ---- synthetic DPoP client -------------------------------------------------

interface DpopKey {
  privateKey: KeyObject
  publicJwk: JsonWebKey
  jkt: string
}

function generateDpopKey(): DpopKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  return { privateKey, publicJwk, jkt: computeJwkThumbprint(publicJwk) }
}

interface ProofClaims {
  htm: string
  htu: string
  ath?: string
  iat?: number
  jti?: string
  /** Override the header (e.g. a wrong alg / typ) for negative tests. */
  header?: Record<string, unknown>
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/** base64url(SHA-256(access token)) — the `ath` claim value. */
function ath(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'ascii').digest('base64url')
}

/** Crafts a real ES256 DPoP proof JWT signed by `key`. */
function makeProof(key: DpopKey, claims: ProofClaims): string {
  const header = claims.header ?? { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk }
  const payload: Record<string, unknown> = {
    htm: claims.htm,
    htu: claims.htu,
    iat: claims.iat ?? Math.floor(Date.now() / 1000),
    jti: claims.jti ?? randomBytes(16).toString('base64url'),
  }
  if (claims.ath !== undefined) payload.ath = claims.ath
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${b64url(signature)}`
}

// ---- HTTP helpers (mirroring oauth-flow.test.ts) ---------------------------

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function registerClient(port: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  })
  return (await res.json()) as Record<string, unknown>
}

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

/** GET /authorize (optionally declaring `dpop_jkt`) and return the redirect's `code`. */
async function authorizeForCode(port: number, clientId: string, challenge: string, dpopJkt?: string): Promise<string> {
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st',
  }
  if (dpopJkt !== undefined) params.dpop_jkt = dpopJkt
  const res = await rawRequest(port, `/authorize?${new URLSearchParams(params).toString()}`)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.location!)
  const err = location.searchParams.get('error')
  if (err) throw new Error(`authorize error redirect: ${err}`)
  return location.searchParams.get('code')!
}

async function postToken(
  port: number,
  params: Record<string, string>,
  dpopProof?: string
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (dpopProof !== undefined) headers.DPoP = dpopProof
  const res = await fetch(`http://127.0.0.1:${port}/token`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* left as text */
  }
  return { status: res.status, json, text }
}

/** Full DPoP issuance: authorize (declaring the key) -> token (proving it). Returns the token response. */
async function dpopFlow(port: number, clientId: string, key: DpopKey): Promise<Record<string, unknown>> {
  const { verifier, challenge } = pkce()
  const code = await authorizeForCode(port, clientId, challenge, key.jkt)
  const proof = makeProof(key, { htm: 'POST', htu: `http://127.0.0.1:${port}/token` })
  const { status, json } = await postToken(
    port,
    { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT },
    proof
  )
  expect(status).toBe(200)
  return json
}

/** Plain-bearer issuance: no `dpop_jkt`, no proof. Returns the token response. */
async function bearerFlow(port: number, clientId: string): Promise<Record<string, unknown>> {
  const { verifier, challenge } = pkce()
  const code = await authorizeForCode(port, clientId, challenge)
  const { status, json } = await postToken(port, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
  })
  expect(status).toBe(200)
  return json
}

/**
 * Raw POST /mcp with a NON-initialize, session-less body. If the DPoP proof is
 * ACCEPTED, the request passes `dpopEnforcement` and `mcpEndpointHandler`
 * immediately 400s ("expected an initialize request") — so a 400 proves the
 * proof was accepted, and a 401 proves it was rejected. Avoids the SSE stream a
 * real initialize would open.
 */
async function mcpProbe(
  port: number,
  accessToken: string,
  dpopProof: string | undefined
): Promise<{ status: number; wwwAuth: string | undefined; body: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${accessToken}`,
  }
  if (dpopProof !== undefined) headers.DPoP = dpopProof
  const res = await rawRequest(port, '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  return { status: res.status, wwwAuth: res.headers['www-authenticate'], body: res.body }
}

/** A `/mcp` proof for `mcpProbe` (POST, correct htu + ath) with optional overrides. */
function mcpProof(port: number, key: DpopKey, accessToken: string, overrides: Partial<ProofClaims> = {}): string {
  return makeProof(key, {
    htm: 'POST',
    htu: `http://127.0.0.1:${port}/mcp`,
    ath: ath(accessToken),
    ...overrides,
  })
}

// ---- tests -----------------------------------------------------------------

describe('DPoP issuance binding at /token', () => {
  it('binds the proof key: a declared+proven DPoP client gets DPoP tokens with the action scope', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()

    const tokens = await dpopFlow(handle.port, client.client_id as string, key)
    expect(tokens.token_type).toBe('DPoP')
    // High-sensitivity scope retained BECAUSE the client is DPoP-bound.
    expect((tokens.scope as string).split(' ')).toContain('clad:actions.request')
    // The grant is recorded DPoP-bound at high sensitivity.
    const grant = store.listGrants()[0]
    expect(grant.dpopBound).toBe(true)
    expect(grant.maxScopeSensitivity).toBe('high')
  })

  it('a DPoP-bound grant REQUIRES a proof at /token — no proof rejects (no downgrade to bearer)', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const { verifier, challenge } = pkce()
    const code = await authorizeForCode(handle.port, client.client_id as string, challenge, key.jkt)

    // Same code, but NO DPoP header at /token.
    const { status, json } = await postToken(handle.port, {
      grant_type: 'authorization_code',
      client_id: client.client_id as string,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    })
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_grant')
  })

  it('a malformed proof at /token 400s with invalid_dpop_proof before any token is minted', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const { verifier, challenge } = pkce()
    const code = await authorizeForCode(handle.port, client.client_id as string, challenge, key.jkt)

    // Wrong htm on the /token proof.
    const badProof = makeProof(key, { htm: 'GET', htu: `http://127.0.0.1:${handle.port}/token` })
    const { status, json } = await postToken(
      handle.port,
      { grant_type: 'authorization_code', client_id: client.client_id as string, code, code_verifier: verifier, redirect_uri: REDIRECT },
      badProof
    )
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_dpop_proof')
  })
})

describe('DPoP enforcement at /mcp', () => {
  it('happy path: a bound token + a fresh valid proof per request drives a real tools/call', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, key)
    const accessToken = tokens.access_token as string

    // A custom fetch that stamps a FRESH DPoP proof (fresh jti) on every
    // request the SDK client makes — proving per-request enforcement works
    // end-to-end through a genuine MCP session, not just a single probe.
    const dpopFetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET'
      const htu = typeof url === 'string' ? url.split('?')[0] : `${url.origin}${url.pathname}`
      const proof = makeProof(key, { htm: method, htu, ath: ath(accessToken) })
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${accessToken}`)
      headers.set('DPoP', proof)
      return fetch(url, { ...init, headers })
    }

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      fetch: dpopFetch as unknown as typeof fetch,
    })
    const c = new Client({ name: 'dpop-test', version: '0.0.0' }, { capabilities: {} })
    await c.connect(transport)
    clients.push(c)

    const result = await c.callTool({ name: 'clad_get_balances', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('acc_checking_001')
  })

  it('a bound token with NO proof 401s with invalid_token and a DPoP challenge', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, key)

    const res = await mcpProbe(handle.port, tokens.access_token as string, undefined)
    expect(res.status).toBe(401)
    expect(res.wwwAuth).toContain('DPoP')
    expect(res.wwwAuth).toContain('invalid_token')
    expect(res.wwwAuth).toContain('algs="ES256"')
  })

  it('a valid proof is ACCEPTED (passes enforcement -> transport 400s the non-initialize body)', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, key)
    const accessToken = tokens.access_token as string

    const res = await mcpProbe(handle.port, accessToken, mcpProof(handle.port, key, accessToken))
    // 400 (not 401) => the proof passed DPoP enforcement and reached the transport.
    expect(res.status).toBe(400)
  })

  it('replay: the same jti twice is rejected the second time (401 invalid_dpop_proof)', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, key)
    const accessToken = tokens.access_token as string

    const proof = mcpProof(handle.port, key, accessToken, { jti: 'reused-jti-123' })
    const first = await mcpProbe(handle.port, accessToken, proof)
    expect(first.status).toBe(400) // accepted (transport 400s the body)
    const second = await mcpProbe(handle.port, accessToken, proof)
    expect(second.status).toBe(401)
    expect(second.wwwAuth).toContain('invalid_dpop_proof')
  })

  it('a proof signed by a DIFFERENT key (thumbprint mismatch) 401s', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const boundKey = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, boundKey)
    const accessToken = tokens.access_token as string

    const attackerKey = generateDpopKey()
    const res = await mcpProbe(handle.port, accessToken, mcpProof(handle.port, attackerKey, accessToken))
    expect(res.status).toBe(401)
    expect(res.wwwAuth).toContain('invalid_dpop_proof')
  })

  it('an htu mismatch 401s', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, key)
    const accessToken = tokens.access_token as string

    const res = await mcpProbe(
      handle.port,
      accessToken,
      mcpProof(handle.port, key, accessToken, { htu: `http://127.0.0.1:${handle.port}/wrong` })
    )
    expect(res.status).toBe(401)
    expect(res.wwwAuth).toContain('invalid_dpop_proof')
  })

  it('an htm mismatch 401s', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, key)
    const accessToken = tokens.access_token as string

    const res = await mcpProbe(handle.port, accessToken, mcpProof(handle.port, key, accessToken, { htm: 'GET' }))
    expect(res.status).toBe(401)
    expect(res.wwwAuth).toContain('invalid_dpop_proof')
  })

  it('a stale iat 401s', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, key)
    const accessToken = tokens.access_token as string

    const staleIat = Math.floor(Date.now() / 1000) - 3600 // 1h old, well past the 300s window
    const res = await mcpProbe(handle.port, accessToken, mcpProof(handle.port, key, accessToken, { iat: staleIat }))
    expect(res.status).toBe(401)
    expect(res.wwwAuth).toContain('invalid_dpop_proof')
  })

  it('an ath mismatch (proof bound to a different token) 401s', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, key)
    const accessToken = tokens.access_token as string

    // Correct key, correct htu/htm, but ath computed over the WRONG token.
    const res = await mcpProbe(
      handle.port,
      accessToken,
      makeProof(key, { htm: 'POST', htu: `http://127.0.0.1:${handle.port}/mcp`, ath: ath('some-other-token') })
    )
    expect(res.status).toBe(401)
    expect(res.wwwAuth).toContain('invalid_dpop_proof')
  })
})

describe('plain-bearer tokens are COMPLETELY unaffected', () => {
  it('a bearer token needs no proof: /mcp passes enforcement with no DPoP header', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const tokens = await bearerFlow(handle.port, client.client_id as string)
    expect(tokens.token_type).toBe('Bearer')

    // No DPoP header at all -> passes dpopEnforcement (jkt undefined) -> transport 400s the body. Never 401.
    const res = await mcpProbe(handle.port, tokens.access_token as string, undefined)
    expect(res.status).toBe(400)
  })

  it('a real bearer tools/call still works end-to-end (no DPoP anywhere)', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const tokens = await bearerFlow(handle.port, client.client_id as string)

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token as string}` } },
    })
    const c = new Client({ name: 'bearer-test', version: '0.0.0' }, { capabilities: {} })
    await c.connect(transport)
    clients.push(c)
    const result = await c.callTool({ name: 'clad_get_balances', arguments: {} })
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain('acc_checking_001')
  })
})

describe('refresh rotation preserves the DPoP binding', () => {
  it('a bound refresh requires a proof from the SAME key, rejects a different key, and stays bound', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const client = await registerClient(handle.port)
    const key = generateDpopKey()
    const tokens = await dpopFlow(handle.port, client.client_id as string, key)
    const refreshToken = tokens.refresh_token as string
    const clientId = client.client_id as string

    // A rotated-refresh proof from a DIFFERENT key is rejected.
    const attackerKey = generateDpopKey()
    const attackerProof = makeProof(attackerKey, { htm: 'POST', htu: `http://127.0.0.1:${handle.port}/token` })
    const wrongKey = await postToken(
      handle.port,
      { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken },
      attackerProof
    )
    expect(wrongKey.status).toBe(400)
    expect(wrongKey.json.error).toBe('invalid_grant')

    // No proof at all on a bound refresh is also rejected.
    const noProof = await postToken(handle.port, {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    })
    expect(noProof.status).toBe(400)
    expect(noProof.json.error).toBe('invalid_grant')

    // The SAME key rotates successfully and the new pair is still DPoP-bound.
    const sameKeyProof = makeProof(key, { htm: 'POST', htu: `http://127.0.0.1:${handle.port}/token` })
    const rotated = await postToken(
      handle.port,
      { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken },
      sameKeyProof
    )
    expect(rotated.status).toBe(200)
    expect(rotated.json.token_type).toBe('DPoP')
    expect(rotated.json.refresh_token).not.toBe(refreshToken)

    // The rotated access token is enforced as DPoP-bound at /mcp.
    const rotatedAccess = rotated.json.access_token as string
    const accepted = await mcpProbe(handle.port, rotatedAccess, mcpProof(handle.port, key, rotatedAccess))
    expect(accepted.status).toBe(400) // passed enforcement
    const rejected = await mcpProbe(handle.port, rotatedAccess, undefined)
    expect(rejected.status).toBe(401) // no proof -> rejected
  })
})

describe('scope sensitivity is gated on DPoP binding (parent §10)', () => {
  it('a DPoP-bound client holds clad:actions.request; an identical bearer client does NOT', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })

    // DPoP client: declares a key at /authorize, proves it at /token.
    const dpopClient = await registerClient(handle.port)
    const key = generateDpopKey()
    const dpopTokens = await dpopFlow(handle.port, dpopClient.client_id as string, key)
    expect((dpopTokens.scope as string).split(' ')).toContain('clad:actions.request')
    expect(dpopTokens.token_type).toBe('DPoP')

    // Bearer client: SAME policy/profile, no DPoP -> action scope withheld.
    const bearerClient = await registerClient(handle.port)
    const bearerTokens = await bearerFlow(handle.port, bearerClient.client_id as string)
    expect((bearerTokens.scope as string).split(' ')).not.toContain('clad:actions.request')
    expect(bearerTokens.token_type).toBe('Bearer')
  })
})
