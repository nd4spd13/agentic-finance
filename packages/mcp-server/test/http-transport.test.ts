/**
 * Milestone-1 coverage for the loopback Streamable HTTP transport
 * (`src/http-transport.ts`). Spins the REAL server on an ephemeral loopback
 * port and drives it with a REAL `@modelcontextprotocol/sdk` HTTP client — a
 * mock at the transport boundary would mostly test the mock (same reasoning
 * as `packages/desktop/test/mcp-server-manager.test.ts`).
 *
 * Uses `DummyDataProvider` directly (no env / provider-factory) so these
 * tests never touch a real token store — the transport is provider-agnostic,
 * so the dummy provider exercises the exact same wiring the SimpleFIN
 * provider would.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AuditLogger, ApprovalQueue, DummyDataProvider, type PolicyConfig } from '@clad/core'
import { startHttpServer, isLoopbackHost, type HttpServerHandle } from '../src/http-transport.js'
import type { ServerResources } from '../src/server-core.js'

const POLICY: PolicyConfig = {
  agents: {
    'test-agent': {
      description: 'HTTP transport test agent',
      permissions: {
        accounts: { visible: ['checking', 'savings'], balance: true },
        transactions: { read: true },
      },
    },
  },
}

function makeResources(): ServerResources {
  return {
    agentId: 'test-agent',
    policy: POLICY,
    provider: new DummyDataProvider(),
    auditLogger: new AuditLogger(':memory:'),
    approvalQueue: new ApprovalQueue(':memory:'),
  }
}

let handle: HttpServerHandle | undefined
let client: Client | undefined

afterEach(async () => {
  if (client) {
    await client.close().catch(() => undefined)
    client = undefined
  }
  if (handle) {
    await handle.close()
    handle = undefined
  }
})

async function connectClient(port: number): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
  const c = new Client({ name: 'http-transport-test', version: '0.0.0' }, { capabilities: {} })
  await c.connect(transport)
  return c
}

describe('startHttpServer', () => {
  it('binds an ephemeral loopback port and reports it', async () => {
    handle = await startHttpServer(makeResources(), { port: 0 })
    expect(handle.port).toBeGreaterThan(0)
  })

  it('serves tools/list over HTTP (the same tool set as stdio)', async () => {
    handle = await startHttpServer(makeResources(), { port: 0 })
    client = await connectClient(handle.port)

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)

    expect(names).toContain('clad_get_balances')
    expect(names).toContain('clad_get_transactions')
    expect(names.length).toBeGreaterThan(0)
  })

  it('calls a read-only tool over HTTP and returns real (dummy-provider) data, not an error', async () => {
    handle = await startHttpServer(makeResources(), { port: 0 })
    client = await connectClient(handle.port)

    const result = await client.callTool({ name: 'clad_get_balances', arguments: { user_id: 'user123' } })
    const content = result.content as Array<{ type: string; text: string }>

    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('account_id')
    // The bug this whole change fixes is "denied / dummy fallback" — assert the
    // policy allowed the call rather than denying it.
    expect(content[0].text).not.toContain('Denied')
  })

  it('serves two concurrent clients on one server (unlike stdio)', async () => {
    handle = await startHttpServer(makeResources(), { port: 0 })
    const a = await connectClient(handle.port)
    const b = await connectClient(handle.port)
    try {
      const [ra, rb] = await Promise.all([a.listTools(), b.listTools()])
      expect(ra.tools.length).toBeGreaterThan(0)
      expect(rb.tools.length).toBeGreaterThan(0)
    } finally {
      await a.close().catch(() => undefined)
      await b.close().catch(() => undefined)
    }
  })
})

describe('isLoopbackHost (DNS-rebinding guard)', () => {
  it('accepts loopback literals with or without a port', () => {
    expect(isLoopbackHost('127.0.0.1:8765')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost:8765')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('[::1]:8765')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
  })

  it('rejects non-loopback hosts and a missing header', () => {
    expect(isLoopbackHost('evil.example.com')).toBe(false)
    expect(isLoopbackHost('evil.example.com:8765')).toBe(false)
    expect(isLoopbackHost('10.0.0.5:8765')).toBe(false)
    expect(isLoopbackHost(undefined)).toBe(false)
  })
})
