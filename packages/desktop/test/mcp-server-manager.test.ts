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

function makeDummyConfig(dir: string): CladConfig {
  writeFileSync(join(dir, 'policy.yaml'), POLICY_YAML, 'utf-8')
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
  }
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
})
