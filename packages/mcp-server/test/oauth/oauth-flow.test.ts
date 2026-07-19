/**
 * D5.3 WS2 S2-S3 integration coverage: the OAuth metadata + DCR "front door"
 * exercised over the REAL Express app (`buildHttpApp`) and a REAL HTTP
 * client — no mock at the transport boundary, matching every other
 * `mcp-server` integration suite.
 *
 * Scope: everything reachable WITHOUT the (Wave-4, still-throwing) flow
 * methods actually succeeding —
 *  - `/register` (RFC 7591 DCR) round-trips against the real, temp-file
 *    `SqliteGrantStore` the running server itself opened.
 *  - `/authorize`, `/token`, `/revoke` are MOUNTED and REACHABLE, but every
 *    one of them dead-ends on `OAuthFlowNotImplementedError` — this asserts
 *    they fail *cleanly* (no crash, no secret leakage in the response body),
 *    not that they work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http, { type IncomingHttpHeaders } from 'node:http'
import { AuditLogger, ApprovalQueue, DummyDataProvider, SqliteGrantStore, type PolicyConfig } from '@clad/core'
import { startHttpServer, type HttpServerHandle } from '../../src/http-transport.js'
import { CladOAuthProvider } from '../../src/oauth/provider.js'
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

let dir: string
let store: SqliteGrantStore
let handle: HttpServerHandle | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-oauth-flow-'))
  store = new SqliteGrantStore({ dbPath: join(dir, 'grants.sqlite'), passphrase: SECRET_PASSPHRASE })
})

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = undefined
  }
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function oauthResources(): ServerResources {
  return {
    agentId: 'test-agent',
    authRequired: true,
    policy: POLICY,
    provider: new DummyDataProvider(),
    auditLogger: new AuditLogger(':memory:'),
    approvalQueue: new ApprovalQueue(':memory:'),
    oauth: new CladOAuthProvider({ store }),
  }
}

async function registerClient(
  port: number,
  body: Record<string, unknown> = { redirect_uris: ['https://example.com/callback'] }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as Record<string, unknown>
  return { status: res.status, json }
}

/** Raw `node:http` request — used where we need to inspect a 3xx redirect's
 *  Location header without `fetch`'s opaque-redirect restrictions kicking in
 *  for a cross-origin `redirect: 'manual'` target. */
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

describe('POST /register (RFC 7591 DCR) — round-trips against the REAL grant store', () => {
  it('registers a client and the SAME store the server opened can read it back', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })

    const { status, json } = await registerClient(handle.port, {
      redirect_uris: ['https://example.com/callback'],
      client_name: 'Integration Test Client',
      // Explicit 'none': the SDK's own registration handler only skips
      // secret generation when this is LITERALLY 'none' — an omitted
      // `token_endpoint_auth_method` still gets a secret generated
      // (`register.js`'s `isPublicClient` check), which is exercised by the
      // "confidential client" case below instead.
      token_endpoint_auth_method: 'none',
    })

    expect(status).toBe(201)
    expect(json.client_id).toBeTruthy()
    expect(json.client_secret).toBeUndefined()

    // Read through the EXACT store instance the running server constructed
    // `resources.oauth` from — proves persistence isn't just an in-memory
    // echo of the request.
    const persisted = store.getClient(json.client_id as string)
    expect(persisted).toBeDefined()
    expect(persisted?.clientName).toBe('Integration Test Client')
    expect(persisted?.redirectUris).toEqual(['https://example.com/callback'])
  })

  it('registers a confidential client, returns the secret once, and never leaks it back out of a later read', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })

    const { json } = await registerClient(handle.port, {
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'client_secret_post',
    })

    expect(typeof json.client_secret).toBe('string')
    expect((json.client_secret as string).length).toBeGreaterThan(0)

    // getClient (used by the /token and /authorize flows) never surfaces it.
    const read = await new CladOAuthProvider({ store }).clientsStore.getClient(json.client_id as string)
    expect(read?.client_secret).toBeUndefined()
  })
})

describe('flow seams over HTTP — reachable, but fail cleanly (Wave 4 not yet implemented)', () => {
  it('POST /token (authorization_code) fails with a generic 500 — no secret/passphrase leakage in the body', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const { json: client } = await registerClient(handle.port)

    const res = await fetch(`http://127.0.0.1:${handle.port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id as string,
        code: 'fabricated-auth-code',
        code_verifier: 'fabricated-code-verifier',
      }).toString(),
    })
    const bodyText = await res.text()

    expect(res.status).toBe(500)
    const body = JSON.parse(bodyText) as { error: string; error_description: string }
    expect(body.error).toBe('server_error')
    expect(bodyText).not.toContain(SECRET_PASSPHRASE)
    expect(bodyText).not.toContain('fabricated-auth-code')
    expect(bodyText).not.toContain('fabricated-code-verifier')
  })

  it('POST /token (refresh_token) fails with a generic 500 — no secret leakage', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const { json: client } = await registerClient(handle.port)

    const res = await fetch(`http://127.0.0.1:${handle.port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id as string,
        refresh_token: 'fabricated-refresh-token',
      }).toString(),
    })
    const bodyText = await res.text()

    expect(res.status).toBe(500)
    expect(bodyText).not.toContain(SECRET_PASSPHRASE)
    expect(bodyText).not.toContain('fabricated-refresh-token')
  })

  it('POST /revoke fails with a generic 500 — no secret leakage', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const { json: client } = await registerClient(handle.port)

    const res = await fetch(`http://127.0.0.1:${handle.port}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id as string,
        token: 'fabricated-token-to-revoke',
      }).toString(),
    })
    const bodyText = await res.text()

    expect(res.status).toBe(500)
    expect(bodyText).not.toContain(SECRET_PASSPHRASE)
    expect(bodyText).not.toContain('fabricated-token-to-revoke')
  })

  it('GET /authorize redirects to redirect_uri with a generic error, never a raw 500/crash', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const { json: client } = await registerClient(handle.port, {
      redirect_uris: ['https://example.com/callback'],
    })

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id as string,
      redirect_uri: 'https://example.com/callback',
      code_challenge: 'fabricated-s256-challenge',
      code_challenge_method: 'S256',
      state: 'fabricated-state-xyz',
    }).toString()

    const res = await rawRequest(handle.port, `/authorize?${query}`)

    expect(res.status).toBe(302)
    const location = res.headers.location
    expect(location).toBeDefined()
    expect(location!.startsWith('https://example.com/callback?')).toBe(true)
    const redirectUrl = new URL(location!)
    expect(redirectUrl.searchParams.get('error')).toBe('server_error')
    expect(redirectUrl.searchParams.get('state')).toBe('fabricated-state-xyz')
    expect(res.body).not.toContain(SECRET_PASSPHRASE)
  })
})
