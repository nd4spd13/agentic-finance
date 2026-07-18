/**
 * CLAD-5: `savePolicyAndRestartServer` wraps `writePolicy` (already covered
 * by `policy-data.test.ts`) with the supervised-MCP-child restart decision.
 * These tests use a plain fake `McpRestartHandle` (this suite's established
 * convention — see `mcp-server-manager.test.ts`'s doc comment — is real
 * integration over `child_process`/SDK-transport mocks, but the restart
 * DECISION logic here doesn't need a real child process to verify) rather
 * than mocking; `mcp-server-manager.test.ts` separately proves a real
 * restart against a real dummy-provider child actually re-parses policy.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { savePolicyAndRestartServer, type McpRestartHandle } from '../src/main/lib/policy-save.js'
import type { McpProcessStatus } from '../src/main/lib/mcp-server-manager.js'

let dir: string
let policyPath: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const VALID_POLICY = {
  agents: {
    'agent-1': {
      description: 'Test agent',
      permissions: {
        accounts: { visible: ['checking'], balance: true },
        transactions: { read: true, lookback_days: 30 },
      },
    },
  },
}

const INVALID_POLICY = {
  agents: {
    'agent-1': {
      // missing required "description"
      permissions: {},
    },
  },
}

/** A fake `McpRestartHandle` that records calls and returns canned results — no real child process involved. */
function makeFakeMcp(opts: {
  runningAgentId: string | null
  restartResult?: McpProcessStatus | (() => Promise<McpProcessStatus>)
}): McpRestartHandle & { restartCalls: number } {
  const handle = {
    restartCalls: 0,
    getRunningAgentId: () => opts.runningAgentId,
    restart: async (): Promise<McpProcessStatus> => {
      handle.restartCalls += 1
      if (typeof opts.restartResult === 'function') return opts.restartResult()
      return opts.restartResult ?? { state: 'running', tools: [], restartAttempt: 0 }
    },
  }
  return handle
}

describe('savePolicyAndRestartServer', () => {
  it('never attempts a restart when the write itself fails, and reports ok: false', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-policy-save-test-'))
    policyPath = join(dir, 'policy.yaml')
    const mcp = makeFakeMcp({ runningAgentId: 'default-agent' })

    const result = await savePolicyAndRestartServer(policyPath, INVALID_POLICY, mcp)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Policy validation failed')
    expect(mcp.restartCalls).toBe(0)
  })

  it('writes the file and skips the restart when no server is currently running', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-policy-save-test-'))
    policyPath = join(dir, 'policy.yaml')
    const mcp = makeFakeMcp({ runningAgentId: null })

    const result = await savePolicyAndRestartServer(policyPath, VALID_POLICY, mcp)

    expect(result).toEqual({ ok: true, server_restarted: false })
    expect(mcp.restartCalls).toBe(0)
    expect(readFileSync(policyPath, 'utf-8')).toContain('agent-1')
  })

  it('restarts the server when one is running, and reports server_restarted: true on success', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-policy-save-test-'))
    policyPath = join(dir, 'policy.yaml')
    const mcp = makeFakeMcp({
      runningAgentId: 'default-agent',
      restartResult: { state: 'running', pid: 4242, tools: ['clad_get_balances'], restartAttempt: 0 },
    })

    const result = await savePolicyAndRestartServer(policyPath, VALID_POLICY, mcp)

    expect(result).toEqual({ ok: true, server_restarted: true })
    expect(mcp.restartCalls).toBe(1)
  })

  it('reports ok: true with a restart_error (not ok: false) when the restart lands in a non-running state', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-policy-save-test-'))
    policyPath = join(dir, 'policy.yaml')
    const mcp = makeFakeMcp({
      runningAgentId: 'default-agent',
      restartResult: {
        state: 'crashed',
        tools: [],
        restartAttempt: 1,
        lastError: 'MCP server process exited before it began listening.',
      },
    })

    const result = await savePolicyAndRestartServer(policyPath, VALID_POLICY, mcp)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.server_restarted).toBe(false)
      expect(result.restart_error).toBe('MCP server process exited before it began listening.')
    }
    // The write itself still succeeded — a restart failure never rolls it back.
    expect(readFileSync(policyPath, 'utf-8')).toContain('agent-1')
  })

  it('reports ok: true with a restart_error when restart() throws unexpectedly', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-policy-save-test-'))
    policyPath = join(dir, 'policy.yaml')
    const mcp = makeFakeMcp({
      runningAgentId: 'default-agent',
      restartResult: () => Promise.reject(new Error('boom')),
    })

    const result = await savePolicyAndRestartServer(policyPath, VALID_POLICY, mcp)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.server_restarted).toBe(false)
      expect(result.restart_error).toBe('boom')
    }
  })
})
