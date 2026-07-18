/**
 * D5.3 WS3 S1 integration coverage: the dev-only static-bearer bridge
 * (`staticBearerBridge` in `../src/http-app.ts`) wired end to end with
 * `resolvePrincipal` (`../src/server-core.ts`) over the REAL HTTP transport
 * and a REAL SDK client — same "no mock at the transport boundary" policy as
 * `http-transport.test.ts`.
 *
 * WS3 §8's integration-test description imagines two different bearer
 * tokens each resolving, through the bridge, to a different profile. The
 * actual M1 skeleton (§4) intentionally supports only ONE
 * `CLAD_MCP_STATIC_BEARER=<token>:<profileId>` mapping per process — it's a
 * placeholder standing in for WS2's real multi-client `verifyAccessToken`,
 * not a multi-tenant token store. This suite proves the property §9 actually
 * cares about ("two clients as different profiles on the same process get
 * independent identities — no shared mutable identity state") the way the
 * single-mapping skeleton allows: one client authenticates through the
 * bridge and gets the bridge's profile (`analyst`); a second, concurrently
 * connected client on the SAME server sends no matching bearer and falls
 * back to the env-asserted `resources.agentId` (`admin`) — a different
 * profile, resolved independently on every request. Both requests hit the
 * same `Server`/`resources`, the same tools; if identity were still a
 * process-wide constant (the pre-WS3 bug), both clients would see identical
 * results.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AuditLogger, ApprovalQueue, DummyDataProvider, type PolicyConfig } from '@clad/core'
import { startHttpServer, type HttpServerHandle } from '../src/http-transport.js'
import type { ServerResources } from '../src/server-core.js'

const STATIC_TOKEN = 'test-static-token'
const BRIDGE_PROFILE = 'analyst'
const FALLBACK_PROFILE = 'admin'

// Two agents with deliberately different account visibility so a policy
// decision proves WHICH profile served a given request, not just that some
// decision was made.
const POLICY: PolicyConfig = {
  agents: {
    [BRIDGE_PROFILE]: {
      description: 'Bridge-authenticated analyst — checking only',
      permissions: {
        accounts: { visible: ['checking'], balance: true },
        transactions: { read: true },
      },
    },
    [FALLBACK_PROFILE]: {
      description: 'Env-fallback admin — checking and savings',
      permissions: {
        accounts: { visible: ['checking', 'savings'], balance: true },
        transactions: { read: true },
      },
    },
  },
}

function makeResources(overrides: Partial<ServerResources> = {}): ServerResources {
  return {
    agentId: FALLBACK_PROFILE,
    authRequired: false,
    policy: POLICY,
    provider: new DummyDataProvider(),
    auditLogger: new AuditLogger(':memory:'),
    approvalQueue: new ApprovalQueue(':memory:'),
    ...overrides,
  }
}

let handle: HttpServerHandle | undefined
let clients: Client[] = []
let originalStaticBearer: string | undefined
let originalNodeEnv: string | undefined

beforeEach(() => {
  originalStaticBearer = process.env.CLAD_MCP_STATIC_BEARER
  originalNodeEnv = process.env.NODE_ENV
  process.env.CLAD_MCP_STATIC_BEARER = `${STATIC_TOKEN}:${BRIDGE_PROFILE}`
  // The bridge is only active outside production — force a non-production
  // value so this suite doesn't silently no-op under an unexpected NODE_ENV.
  process.env.NODE_ENV = 'test'
})

afterEach(async () => {
  for (const client of clients) {
    await client.close().catch(() => undefined)
  }
  clients = []
  if (handle) {
    await handle.close()
    handle = undefined
  }
  if (originalStaticBearer === undefined) {
    delete process.env.CLAD_MCP_STATIC_BEARER
  } else {
    process.env.CLAD_MCP_STATIC_BEARER = originalStaticBearer
  }
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = originalNodeEnv
  }
})

async function connectClient(port: number, authorization?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: authorization ? { headers: { Authorization: authorization } } : undefined,
  })
  const c = new Client({ name: 'auth-enforcement-test', version: '0.0.0' }, { capabilities: {} })
  await c.connect(transport)
  clients.push(c)
  return c
}

async function balancesFor(client: Client): Promise<string> {
  const result = await client.callTool({ name: 'clad_get_balances', arguments: {} })
  const content = result.content as Array<{ type: string; text: string }>
  return content[0].text
}

describe('static-bearer bridge + resolvePrincipal over HTTP (per-request identity)', () => {
  it('a request carrying the static bearer resolves to the bridge profile, not the process-constant agentId', async () => {
    handle = await startHttpServer(makeResources(), { port: 0 })
    const client = await connectClient(handle.port, `Bearer ${STATIC_TOKEN}`)

    const balances = await balancesFor(client)
    expect(balances).toContain('acc_checking_001')
    // analyst's policy hides savings — proves the bridge's profileId (not
    // the env-asserted `admin` fallback) drove this decision.
    expect(balances).not.toContain('acc_savings_001')
  })

  it('a request with no (or a non-matching) bearer falls back to the env-asserted agentId', async () => {
    handle = await startHttpServer(makeResources(), { port: 0 })
    const client = await connectClient(handle.port) // no Authorization header at all

    const balances = await balancesFor(client)
    expect(balances).toContain('acc_checking_001')
    expect(balances).toContain('acc_savings_001')
  })

  it('cross-profile isolation: two concurrently connected clients on ONE server get independent, per-request identities', async () => {
    handle = await startHttpServer(makeResources(), { port: 0 })
    const bridgeClient = await connectClient(handle.port, `Bearer ${STATIC_TOKEN}`)
    const fallbackClient = await connectClient(handle.port) // wrong/missing bearer -> env fallback

    const [bridgeBalances, fallbackBalances] = await Promise.all([
      balancesFor(bridgeClient),
      balancesFor(fallbackClient),
    ])

    // Same server process, same `resources`, same tool — different verified
    // identity per request, proven by different policy decisions.
    expect(bridgeBalances).not.toContain('acc_savings_001')
    expect(fallbackBalances).toContain('acc_savings_001')
  })

  it('a non-matching bearer token does not leak into req.auth (bridge only fires on an exact match)', async () => {
    handle = await startHttpServer(makeResources(), { port: 0 })
    const client = await connectClient(handle.port, 'Bearer some-other-token')

    // Falls back to the env-asserted agentId, exactly like no header at all.
    const balances = await balancesFor(client)
    expect(balances).toContain('acc_savings_001')
  })
})
