/**
 * D5.3 WS2 S2 coverage: the two `/.well-known/*` OAuth metadata documents
 * `buildHttpApp` mounts (via the SDK's `mcpAuthRouter`) when
 * `resources.oauth` is set, plus their DELIBERATE absence when it isn't.
 *
 * Spins the REAL server (`startHttpServer`) on an ephemeral loopback port and
 * hits it with a plain `fetch` — same "no mock at the transport boundary"
 * policy as `http-transport.test.ts`. Validates the emitted documents against
 * the SDK's OWN zod schemas (`OAuthProtectedResourceMetadataSchema` /
 * `OAuthMetadataSchema`, `@modelcontextprotocol/sdk/shared/auth.js`) rather
 * than hand-rolled field-by-field expectations, per
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md` §9.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OAuthProtectedResourceMetadataSchema,
  OAuthMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { AuditLogger, ApprovalQueue, DummyDataProvider, SqliteGrantStore, type PolicyConfig } from '@clad/core'
import { startHttpServer, type HttpServerHandle } from '../../src/http-transport.js'
import { CladOAuthProvider } from '../../src/oauth/provider.js'
import { CLAD_SCOPES } from '../../src/oauth/scopes.js'
import type { ServerResources } from '../../src/server-core.js'

const POLICY: PolicyConfig = {
  agents: {
    'test-agent': {
      description: 'OAuth metadata test agent',
      permissions: {
        accounts: { visible: ['checking'], balance: true },
        transactions: { read: true },
      },
    },
  },
}

let dir: string
let store: SqliteGrantStore | undefined
let handle: HttpServerHandle | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-oauth-metadata-'))
})

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = undefined
  }
  if (store) {
    store.close()
    store = undefined
  }
  rmSync(dir, { recursive: true, force: true })
})

function baseResources(overrides: Partial<ServerResources> = {}): ServerResources {
  return {
    agentId: 'test-agent',
    authRequired: false,
    policy: POLICY,
    provider: new DummyDataProvider(),
    auditLogger: new AuditLogger(':memory:'),
    approvalQueue: new ApprovalQueue(':memory:'),
    ...overrides,
  }
}

/** Builds `ServerResources` with a REAL, temp-file-backed OAuth provider (`resources.oauth` set). */
function oauthResources(): ServerResources {
  store = new SqliteGrantStore({ dbPath: join(dir, 'grants.sqlite'), passphrase: 'metadata-test-passphrase' })
  return baseResources({ authRequired: true, oauth: new CladOAuthProvider({ store }) })
}

describe('GET /.well-known/oauth-protected-resource/mcp (RFC 9728) — served when the flag is on', () => {
  it('validates against the SDK\'s own OAuthProtectedResourceMetadataSchema', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-protected-resource/mcp`)
    expect(res.status).toBe(200)
    const body: unknown = await res.json()
    const parsed = OAuthProtectedResourceMetadataSchema.parse(body)

    expect(parsed.resource).toBe(`http://127.0.0.1:${handle.port}/mcp`)
    expect(parsed.authorization_servers).toEqual([`http://127.0.0.1:${handle.port}/`])
  })

  it('advertises the exact CLAD_SCOPES vocabulary', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-protected-resource/mcp`)
    const body = OAuthProtectedResourceMetadataSchema.parse(await res.json())
    expect(body.scopes_supported).toEqual([...CLAD_SCOPES])
  })

  it('advertises bearer as a supported method and DPoP as SUPPORTED BUT NEVER REQUIRED (WS2 §4.1, parent §10)', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-protected-resource/mcp`)
    const body = OAuthProtectedResourceMetadataSchema.parse(await res.json())

    expect(body.bearer_methods_supported).toEqual(['header'])
    expect(body.dpop_signing_alg_values_supported).toEqual(['ES256'])
    // The hard invariant: DPoP is advertised as available, but MUST NOT be
    // marked as required server-wide — that would lock out every bearer-only
    // client before M3's enforcement even exists.
    expect(body.dpop_bound_access_tokens_required).not.toBe(true)
  })
})

describe('GET /.well-known/oauth-authorization-server (RFC 8414) — served when the flag is on', () => {
  it('validates against the SDK\'s own OAuthMetadataSchema', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`)
    expect(res.status).toBe(200)
    const body: unknown = await res.json()
    const parsed = OAuthMetadataSchema.parse(body)

    expect(parsed.issuer).toBe(`http://127.0.0.1:${handle.port}/`)
    expect(parsed.authorization_endpoint).toBe(`http://127.0.0.1:${handle.port}/authorize`)
    expect(parsed.token_endpoint).toBe(`http://127.0.0.1:${handle.port}/token`)
    expect(parsed.registration_endpoint).toBe(`http://127.0.0.1:${handle.port}/register`)
    expect(parsed.revocation_endpoint).toBe(`http://127.0.0.1:${handle.port}/revoke`)
  })

  it('is PKCE S256-only — never advertises "plain"', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`)
    const body = OAuthMetadataSchema.parse(await res.json())

    expect(body.code_challenge_methods_supported).toEqual(['S256'])
  })

  it('supports only "none" and "client_secret_post" token-endpoint auth methods — never client_secret_basic', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`)
    const body = OAuthMetadataSchema.parse(await res.json())

    expect(body.token_endpoint_auth_methods_supported).toEqual(
      expect.arrayContaining(['none', 'client_secret_post'])
    )
    expect(body.token_endpoint_auth_methods_supported).not.toEqual(
      expect.arrayContaining(['client_secret_basic'])
    )
  })

  it('advertises DPoP as supported (never required) on the AS document too', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`)
    const body = OAuthMetadataSchema.parse(await res.json())

    expect(body.dpop_signing_alg_values_supported).toEqual(['ES256'])
  })

  it('advertises the exact CLAD_SCOPES vocabulary', async () => {
    handle = await startHttpServer(oauthResources(), { port: 0 })
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`)
    const body = OAuthMetadataSchema.parse(await res.json())

    expect(body.scopes_supported).toEqual([...CLAD_SCOPES])
  })
})

describe('flag-off inertness (resources.oauth undefined — CLAD_MCP_AUTH unset)', () => {
  it('serves neither /.well-known/* document — no route is mounted at all', async () => {
    handle = await startHttpServer(baseResources(), { port: 0 })

    const prm = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-protected-resource/mcp`)
    const as = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`)

    expect(prm.status).toBe(404)
    expect(as.status).toBe(404)
  })

  it('does not mount /register either', async () => {
    handle = await startHttpServer(baseResources(), { port: 0 })

    const res = await fetch(`http://127.0.0.1:${handle.port}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://example.com/callback'] }),
    })

    expect(res.status).toBe(404)
  })
})
