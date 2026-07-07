import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import { AuditLogger, type PolicyConfig } from '@clad/core'
import { handleToolCall } from '../src/server.js'
import type { ToolDefinition, ToolContext } from '../src/types.js'

const FAKE_TOKEN = 'access-sandbox-abc123-fake'

/**
 * A tool whose handler throws an error embedding a fake Plaid access token,
 * simulating a Plaid SDK error (e.g. an axios error whose message embeds
 * request body/header content) bubbling up through a provider call.
 */
const throwingTool: ToolDefinition = {
  name: 'clad_throws',
  description: 'Test tool that always throws with a token-bearing message',
  inputSchema: { type: 'object', properties: {}, required: [] },
  async handler() {
    throw new Error(
      `Plaid request failed: config={"headers":{"PLAID-SECRET":"${FAKE_TOKEN}"}}, token=${FAKE_TOKEN}`
    )
  },
}

function buildRequest(name: string): CallToolRequest {
  return {
    method: 'tools/call',
    params: { name, arguments: {} },
  }
}

describe('handleToolCall — redaction hardening (CRS-25 WP6)', () => {
  let tmpDir: string
  let auditDbPath: string
  let auditLogger: AuditLogger
  const policy: PolicyConfig = { agents: { 'test-agent': { description: 'test', permissions: {} } } }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clad-audit-test-'))
    auditDbPath = join(tmpDir, 'audit.sqlite')
    auditLogger = new AuditLogger(auditDbPath)
  })

  afterEach(() => {
    try {
      auditLogger.close()
    } catch {
      // already closed by a test that needed to flush to disk before inspecting bytes
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('redacts a token embedded in a thrown error before it reaches the audit DB', async () => {
    const context: Omit<ToolContext, 'agentId'> = {
      policy,
      provider: {
        getAccounts: async () => [],
        getTransactions: async () => [],
        getBalance: async () => {
          throw new Error('unused')
        },
      },
      auditLogger,
      approvalQueue: undefined as unknown as ToolContext['approvalQueue'],
    }

    await handleToolCall(buildRequest('clad_throws'), {
      tools: [throwingTool],
      agentId: 'test-agent',
      context,
      auditLogger,
    })

    const records = auditLogger.getRecords({ agent_id: 'test-agent' })
    expect(records).toHaveLength(1)
    const [record] = records
    expect(record.decision).toBe('deny')
    expect(record.reason).toContain('[REDACTED]')
    expect(record.reason).not.toContain(FAKE_TOKEN)
  })

  it('redacts a token embedded in a thrown error before it reaches the MCP client', async () => {
    const context: Omit<ToolContext, 'agentId'> = {
      policy,
      provider: {
        getAccounts: async () => [],
        getTransactions: async () => [],
        getBalance: async () => {
          throw new Error('unused')
        },
      },
      auditLogger,
      approvalQueue: undefined as unknown as ToolContext['approvalQueue'],
    }

    const result = await handleToolCall(buildRequest('clad_throws'), {
      tools: [throwingTool],
      agentId: 'test-agent',
      context,
      auditLogger,
    })

    const text = result.content[0]?.text ?? ''
    expect(text).toContain('[REDACTED]')
    expect(text).not.toContain(FAKE_TOKEN)
  })

  it('redacts a token embedded in the raw DB file bytes on disk', async () => {
    const context: Omit<ToolContext, 'agentId'> = {
      policy,
      provider: {
        getAccounts: async () => [],
        getTransactions: async () => [],
        getBalance: async () => {
          throw new Error('unused')
        },
      },
      auditLogger,
      approvalQueue: undefined as unknown as ToolContext['approvalQueue'],
    }

    await handleToolCall(buildRequest('clad_throws'), {
      tools: [throwingTool],
      agentId: 'test-agent',
      context,
      auditLogger,
    })
    auditLogger.close()

    const { readFileSync } = await import('node:fs')
    const raw = readFileSync(auditDbPath, 'latin1')
    expect(raw).not.toContain(FAKE_TOKEN)
  })

  it('redacts JSON.stringify(args) on the success path (defense in depth)', async () => {
    const successTool: ToolDefinition = {
      name: 'clad_success',
      description: 'Test tool that succeeds',
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    }

    const context: Omit<ToolContext, 'agentId'> = {
      policy,
      provider: {
        getAccounts: async () => [],
        getTransactions: async () => [],
        getBalance: async () => {
          throw new Error('unused')
        },
      },
      auditLogger,
      approvalQueue: undefined as unknown as ToolContext['approvalQueue'],
    }

    const request: CallToolRequest = {
      method: 'tools/call',
      params: { name: 'clad_success', arguments: { note: `token=${FAKE_TOKEN}` } },
    }

    await handleToolCall(request, {
      tools: [successTool],
      agentId: 'test-agent',
      context,
      auditLogger,
    })

    const records = auditLogger.getRecords({ agent_id: 'test-agent' })
    expect(records).toHaveLength(1)
    expect(records[0].decision).toBe('allow')
    expect(records[0].reason).toContain('[REDACTED]')
    expect(records[0].reason).not.toContain(FAKE_TOKEN)
  })

  it('returns "Unknown tool" text without touching the audit log for an unregistered tool', async () => {
    const context: Omit<ToolContext, 'agentId'> = {
      policy,
      provider: {
        getAccounts: async () => [],
        getTransactions: async () => [],
        getBalance: async () => {
          throw new Error('unused')
        },
      },
      auditLogger,
      approvalQueue: undefined as unknown as ToolContext['approvalQueue'],
    }

    const result = await handleToolCall(buildRequest('does_not_exist'), {
      tools: [throwingTool],
      agentId: 'test-agent',
      context,
      auditLogger,
    })

    expect(result.content[0]?.text).toContain('Unknown tool')
    expect(auditLogger.getRecords({ agent_id: 'test-agent' })).toHaveLength(0)
  })
})

describe('writeRedactedStderr behavior via main() fatal path', () => {
  it('redactSecrets strips tokens from a stderr-style fatal message (unit check on the pattern used by server.ts)', async () => {
    const { redactSecrets } = await import('@clad/core')
    const message = `[clad server] fatal: Error: token leaked ${FAKE_TOKEN}\n`
    const redacted = redactSecrets(message)
    expect(redacted).not.toContain(FAKE_TOKEN)
    expect(redacted).toContain('[REDACTED]')
  })
})
