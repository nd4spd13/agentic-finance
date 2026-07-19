/**
 * D5.3 WS2 S5 / WS3 integration coverage: `verifyAccessToken` -> `req.auth` ->
 * `resolvePrincipal` produces a REAL per-request agent identity. Mirrors
 * `auth-enforcement.test.ts` (the static-bearer skeleton) but with genuine
 * OAuth-minted opaque tokens verified through the real `requireBearerAuth` +
 * `CladOAuthProvider.verifyAccessToken` chain (TEST-PLAN §3).
 *
 * Two clients hold tokens bound to two DIFFERENT profiles and connect
 * concurrently to ONE flag-on server. If identity were a process-wide constant
 * (the pre-D5.3 bug) both would see identical data; instead each request
 * resolves to its own token's profile, proven by divergent policy decisions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Response } from 'express'
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
import type { ConsentFn } from '../../src/oauth/consent.js'
import type { ServerResources } from '../../src/server-core.js'

const ANALYST = 'analyst'
const ADMIN = 'admin'
const REDIRECT = 'https://example.com/callback'

const POLICY: PolicyConfig = {
  agents: {
    [ANALYST]: {
      description: 'analyst — checking only',
      permissions: { accounts: { visible: ['checking'], balance: true }, transactions: { read: true } },
    },
    [ADMIN]: {
      description: 'admin — checking and savings',
      permissions: { accounts: { visible: ['checking', 'savings'], balance: true }, transactions: { read: true } },
    },
  },
}

let dir: string
let store: SqliteGrantStore
let provider: CladOAuthProvider
let handle: HttpServerHandle | undefined
let clients: Client[] = []
let consentProfile = ANALYST

// A consent seam that approves whichever profile the current mint targets.
const sequencedConsent: ConsentFn = async () => ({ approved: true, profileId: consentProfile, dpopBound: false })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-token-identity-'))
  store = new SqliteGrantStore({ dbPath: join(dir, 'grants.sqlite'), passphrase: 'token-identity-passphrase' })
  provider = new CladOAuthProvider({
    store,
    policy: POLICY,
    trust: new LocalConsentTrustProvider(POLICY, mintScopesForProfile, scopeSensitivity),
    requestConsent: sequencedConsent,
  })
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

function resources(): ServerResources {
  return {
    agentId: 'unused-fallback',
    authRequired: true,
    policy: POLICY,
    provider: new DummyDataProvider(),
    auditLogger: new AuditLogger(':memory:'),
    approvalQueue: new ApprovalQueue(':memory:'),
    oauth: provider,
  }
}

/** Mints a real opaque access token bound to `profileId` via authorize -> exchange. */
async function mintAccessToken(profileId: string): Promise<string> {
  consentProfile = profileId
  const client = await provider.clientsStore.registerClient!({
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
    client_name: `client-${profileId}`,
  })
  const challenge = createHash('sha256').update('verifier').digest('base64url')
  let redirectUrl = ''
  const res = { redirect: (_status: number, url: string) => (redirectUrl = url) } as unknown as Response
  await provider.authorize(client, { codeChallenge: challenge, redirectUri: REDIRECT }, res)
  const code = new URL(redirectUrl).searchParams.get('code')!
  const tokens = await provider.exchangeAuthorizationCode(client, code, 'verifier', REDIRECT)
  return tokens.access_token
}

async function connectMcp(port: number, bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  })
  const c = new Client({ name: 'token-identity-test', version: '0.0.0' }, { capabilities: {} })
  await c.connect(transport)
  clients.push(c)
  return c
}

async function balancesFor(client: Client): Promise<string> {
  const result = await client.callTool({ name: 'clad_get_balances', arguments: {} })
  return (result.content as Array<{ type: string; text: string }>)[0].text
}

describe('per-request identity from real OAuth tokens (verifyAccessToken -> resolvePrincipal)', () => {
  it('two concurrent clients on ONE server resolve to their own token-bound profiles', async () => {
    const analystToken = await mintAccessToken(ANALYST)
    const adminToken = await mintAccessToken(ADMIN)

    handle = await startHttpServer(resources(), { port: 0 })
    const analystClient = await connectMcp(handle.port, analystToken)
    const adminClient = await connectMcp(handle.port, adminToken)

    const [analystBalances, adminBalances] = await Promise.all([
      balancesFor(analystClient),
      balancesFor(adminClient),
    ])

    // Different verified identity per request, proven by divergent policy views.
    expect(analystBalances).toContain('acc_checking_001')
    expect(analystBalances).not.toContain('acc_savings_001')
    expect(adminBalances).toContain('acc_checking_001')
    expect(adminBalances).toContain('acc_savings_001')
  })

  it('an unrecognized bearer token cannot connect at all (requireBearerAuth 401s)', async () => {
    handle = await startHttpServer(resources(), { port: 0 })
    await expect(connectMcp(handle.port, 'not-a-real-token')).rejects.toThrow()
  })
})
