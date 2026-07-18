/**
 * Integration-style tests: these spawn a REAL `@clad/mcp-server` dummy-
 * provider child process (same technique the S0.4 spike proved out) rather
 * than mocking `child_process`/the SDK transport — the manager constructs
 * `StdioClientTransport`/`Client` directly, so a mock at that boundary would
 * mostly be testing the mock. The one thing NOT covered here is the full
 * exponential-backoff *timing* across many attempts (would make the suite
 * slow/flaky); `computeBackoffDelayMs`'s math is covered directly in
 * `mcp-backoff.test.ts`, and the live crash-loop behavior is a manual/
 * packaged-app QA step (see the D1 manual QA notes in desktop-app.md).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServerManager } from '../src/main/lib/mcp-server-manager.js'
import type { CladConfig } from '../src/main/lib/config.js'

/**
 * Grabs a free loopback port so these tests don't collide with the fixed
 * `DEFAULT_MCP_HTTP_PORT` (8765) a developer might have in use, and so
 * separate test files can run in parallel workers without fighting over one
 * port. The manager reads `CLAD_MCP_HTTP_PORT` at spawn time (see
 * `resolveMcpHttpPort`), so setting it in `beforeEach` is enough.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

const POLICY_YAML = `
agents:
  default-agent:
    description: D1.2 manager test — dummy provider
    permissions:
      accounts:
        visible:
          - acc_checking_001
          - acc_savings_001
          - acc_credit_001
        balance: true
        account_number: false
        routing_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 30
      audit:
        log_all_queries: true
        log_policy_evaluations: true
        retention: 90d

global:
  max_total_daily_spend: 10000
  max_concurrent_agents: 5
  require_human_approval_above: 1000
  default_escalation_timeout: 300
`

/**
 * The v0.5.0 repro shape: a realistic user-edited policy with NO
 * `default-agent` in it at all. `analyst` may see balances, `finance-agent`
 * may not — a per-agent difference that a tool call can observe, which is how
 * the identity tests below prove the child really is running as the agent it
 * claims rather than merely reporting one.
 */
const NO_DEFAULT_AGENT_POLICY_YAML = `
agents:
  analyst:
    description: Repro policy — may read balances.
    permissions:
      accounts:
        visible: []
        balance: true
        account_number: false
        routing_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 30
      audit:
        log_all_queries: true
        log_policy_evaluations: true
  finance-agent:
    description: Repro policy — may NOT read balances.
    permissions:
      accounts:
        visible: []
        balance: false
        account_number: false
        routing_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 30
      audit:
        log_all_queries: true
        log_policy_evaluations: true
`

function makeDummyConfig(dir: string, policyYaml: string = POLICY_YAML): CladConfig {
  writeFileSync(join(dir, 'policy.yaml'), policyYaml, 'utf-8')
  return {
    policy_path: join(dir, 'policy.yaml'),
    audit_db: join(dir, 'audit.sqlite'),
    approval_db: join(dir, 'approvals.sqlite'),
    server_pid_file: join(dir, 'server.pid'),
    provider: 'dummy',
    plaid_db: join(dir, 'plaid.sqlite'),
    plaid_env: 'sandbox',
    close_to_tray: true,
    simplefin_db: join(dir, 'simplefin.sqlite'),
    agent_id: '',
  }
}

/**
 * Clients opened by `callToolOverLoopback`, closed in `afterEach` BEFORE the
 * manager stops its child — same single-`client.close()` teardown
 * `packages/mcp-server/test/http-transport.test.ts` uses. Closing them after
 * the child is gone aborts an in-flight SSE read against a dead socket, which
 * surfaces as an unhandled `setTypeOfService EINVAL` from undici.
 */
const loopbackClients: Client[] = []

/** Must be called before anything kills the child a client is attached to. */
async function closeLoopbackClients(): Promise<void> {
  for (const client of loopbackClients.splice(0)) {
    await client.close().catch(() => undefined)
  }
}

/**
 * Calls a tool over the loopback HTTP server as an INDEPENDENT client —
 * exactly the path Claude Desktop's `mcp-remote` proxy takes (the manager's
 * own readiness client stays connected alongside it, which is the whole point
 * of the HTTP transport). Deliberately not routed through the manager: the
 * regression these tests guard is about what a third-party client's tool call
 * gets back, and the manager never exposed a `callTool` for one to hide
 * behind.
 */
async function callToolOverLoopback(toolName: string, args: Record<string, unknown> = {}): Promise<string> {
  const url = new URL(`http://127.0.0.1:${process.env.CLAD_MCP_HTTP_PORT}/mcp`)
  const client = new Client({ name: 'clad-desktop-test-client', version: '0.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(url))
  loopbackClients.push(client)
  const result = (await client.callTool({ name: toolName, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>
  }
  return (result.content ?? []).map((part) => part.text ?? '').join('\n')
}

async function waitFor(predicate: () => boolean, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 50 } = opts
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

let dir: string | undefined
let manager: McpServerManager | undefined
let prevHttpPort: string | undefined

beforeEach(async () => {
  prevHttpPort = process.env.CLAD_MCP_HTTP_PORT
  process.env.CLAD_MCP_HTTP_PORT = String(await getFreePort())
})

afterEach(async () => {
  await closeLoopbackClients() // before manager.stop() — see `loopbackClients`
  if (manager) {
    await manager.stop()
    manager = undefined
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
  if (prevHttpPort === undefined) delete process.env.CLAD_MCP_HTTP_PORT
  else process.env.CLAD_MCP_HTTP_PORT = prevHttpPort
})

describe('McpServerManager', () => {
  it('start() spawns a real dummy-provider server and reaches "running" with tools listed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      onStatusChange: () => undefined,
    })

    const status = await manager.start()

    expect(status.state).toBe('running')
    expect(typeof status.pid).toBe('number')
    expect(status.tools).toContain('clad_get_balances')
    expect(status.tools.length).toBeGreaterThan(0)
  }, 10_000)

  it('stop() cleanly returns to "stopped" with no pid', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      onStatusChange: () => undefined,
    })
    await manager.start()

    const status = await manager.stop()

    expect(status.state).toBe('stopped')
    expect(status.pid).toBeUndefined()
  }, 10_000)

  it('start() is a no-op while already running (does not spawn a second process)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      onStatusChange: () => undefined,
    })
    const first = await manager.start()

    const second = await manager.start()

    expect(second.pid).toBe(first.pid)
  }, 10_000)

  it('fails fast with a clear error when provider=plaid but credentials are missing (no process spawned)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config: CladConfig = { ...makeDummyConfig(dir), provider: 'plaid' }
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      onStatusChange: () => undefined,
    })

    const status = await manager.start()

    expect(status.state).toBe('crashed')
    expect(status.pid).toBeUndefined()
    expect(status.lastError).toMatch(/credentials|passphrase/i)
  }, 10_000)

  it('fails fast with a clear error when provider=simplefin but the passphrase is missing (no process spawned)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config: CladConfig = { ...makeDummyConfig(dir), provider: 'simplefin' }
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      onStatusChange: () => undefined,
    })

    const status = await manager.start()

    expect(status.state).toBe('crashed')
    expect(status.pid).toBeUndefined()
    expect(status.lastError).toMatch(/passphrase/i)
  }, 10_000)

  it('start() spawns a real simplefin-provider server (passphrase only, no Plaid credentials needed) and reaches "running" with tools listed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config: CladConfig = { ...makeDummyConfig(dir), provider: 'simplefin' }
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => 'a-test-passphrase',
      onStatusChange: () => undefined,
    })

    const status = await manager.start()

    expect(status.state).toBe('running')
    expect(typeof status.pid).toBe('number')
    expect(status.tools).toContain('clad_get_balances')
  }, 10_000)

  it('detects an unexpected process exit and auto-restarts with a new process', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    const states: string[] = []
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      onStatusChange: (status) => states.push(status.state),
    })
    const running = await manager.start()
    expect(running.pid).toBeDefined()

    process.kill(running.pid!, 'SIGKILL')

    await waitFor(() => states.includes('crashed'), { timeoutMs: 5000 })

    // Backoff attempt 0 is ~1s (BACKOFF_BASE_MS) — give it real time to fire
    // and spawn a replacement process automatically, with no manual start().
    await waitFor(() => manager!.getStatus().state === 'running' && manager!.getStatus().pid !== running.pid, {
      timeoutMs: 8000,
    })
    expect(manager.getStatus().restartAttempt).toBeGreaterThanOrEqual(1)
  }, 15_000)

  /**
   * v0.5.0 REGRESSION SUITE. `buildServerEnv` set no `CLAD_AGENT_ID`, so the
   * supervised child fell back to `server-core.ts`'s hardcoded
   * `'default-agent'`. That was invisible while the child only ever served
   * `tools/list` (which never consults policy), and became "every Claude
   * Desktop tool call is denied" the moment PR #68 routed those calls here.
   *
   * The first test below is the one whose absence let the bug ship: every
   * pre-existing manager test used a policy that happened to define
   * `default-agent`, and none of them called a policy-consulting tool.
   */
  describe('agent identity', () => {
    it('REGRESSION: a tool call against a policy with NO default-agent succeeds instead of being denied for an unknown agent', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      // agent_id unset, exactly like every config.json written before the
      // field existed — the child must still resolve a REAL policy agent.
      const config = makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML)
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => null,
        onStatusChange: () => undefined,
      })
      await manager.start()

      const text = await callToolOverLoopback('clad_get_balances')

      expect(text).not.toMatch(/unknown agent/i)
      expect(text).not.toMatch(/^Denied:/)
      // Deterministic sorted-first resolution, and a real agent in the policy.
      expect(manager.getRunningAgentId()).toBe('analyst')
    }, 15_000)

    it('runs as the configured agent_id, and the policy evaluates its permissions (not another agent\'s)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      // 'finance-agent' is the one denied balance visibility — so a denial
      // here proves the configured identity reached the policy engine, and a
      // denial with THIS reason (not 'unknown agent') proves it's a real one.
      const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'finance-agent' }
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => null,
        onStatusChange: () => undefined,
      })
      await manager.start()

      const text = await callToolOverLoopback('clad_get_balances')

      expect(manager.getRunningAgentId()).toBe('finance-agent')
      expect(text).toMatch(/balance visibility disabled/i)
      expect(text).not.toMatch(/unknown agent/i)
    }, 15_000)

    it('a changed agent_id takes effect on restart (no stale identity served by an old child)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'analyst' }
      manager = new McpServerManager({
        // Mutable, re-read on every spawn — models the real deps object,
        // which calls loadConfig() fresh each time.
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => null,
        onStatusChange: () => undefined,
      })
      await manager.start()
      expect(manager.getRunningAgentId()).toBe('analyst')
      expect(await callToolOverLoopback('clad_get_balances')).not.toMatch(/^Denied:/)

      config.agent_id = 'finance-agent'
      await closeLoopbackClients() // the restart below kills the child they're attached to
      // Point the restarted child at a fresh port (the manager re-resolves it
      // per spawn). Purely test isolation: `fetch`'s connection pool would
      // otherwise reuse the keep-alive socket it opened to the OLD child,
      // which the restart has since killed, and writing to that dead socket
      // surfaces as an unhandled `setTypeOfService EINVAL` from undici. The
      // real app keeps one fixed port across restarts — see
      // `DEFAULT_MCP_HTTP_PORT` — and its clients reconnect rather than
      // holding a pooled socket across a child's lifetime.
      process.env.CLAD_MCP_HTTP_PORT = String(await getFreePort())
      await manager.restart()

      expect(manager.getRunningAgentId()).toBe('finance-agent')
      // Observable proof the NEW identity is in force, not the old child's.
      expect(await callToolOverLoopback('clad_get_balances')).toMatch(/balance visibility disabled/i)
    }, 20_000)

    it('surfaces a clear lastError (instead of silently denying everything) when the configured agent is not in the policy', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'deleted-agent' }
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => null,
        onStatusChange: () => undefined,
      })

      const status = await manager.start()

      // Still running (a policy typo shouldn't cost the user their server),
      // but the reason is visible in the status surface the UI renders.
      expect(status.state).toBe('running')
      expect(status.lastError).toContain('deleted-agent')
      // A genuine misconfiguration keeps using the "problem" slot, not the
      // informational one added for the implicit-default-choice case below.
      expect(status.agentNotice).toBeUndefined()
      // ...and it fell back to a real agent rather than denying everything.
      expect(manager.getRunningAgentId()).toBe('analyst')
      expect(await callToolOverLoopback('clad_get_balances')).not.toMatch(/unknown agent/i)
    }, 15_000)

    it('surfaces the implicit-default choice via agentNotice, NOT lastError, when no agent is configured and the policy defines several', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      // agent_id unset (from makeDummyConfig's default) + NO_DEFAULT_AGENT_POLICY_YAML
      // defines two agents — the exact "gap" case: nothing is broken, but the
      // running identity was picked by string sort order, not a user choice.
      const config = makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML)
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => null,
        onStatusChange: () => undefined,
      })

      const status = await manager.start()

      expect(status.state).toBe('running')
      // Healthy server, not a problem — must NOT land in the "something is
      // wrong" slot the status panel renders as an error.
      expect(status.lastError).toBeUndefined()
      expect(status.agentNotice).toContain('analyst')
      expect(status.agentNotice).toContain('finance-agent')
      expect(manager.getRunningAgentId()).toBe('analyst')
      expect(await callToolOverLoopback('clad_get_balances')).not.toMatch(/^Denied:/)
    }, 15_000)

    it('getRunningAgentId is null once stopped', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'analyst' }
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => null,
        onStatusChange: () => undefined,
      })
      await manager.start()
      expect(manager.getRunningAgentId()).toBe('analyst')

      await manager.stop()

      expect(manager.getRunningAgentId()).toBeNull()
    }, 15_000)
  })
})
