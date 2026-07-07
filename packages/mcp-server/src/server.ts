import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { parsePolicy, AuditLogger, ApprovalQueue, redactSecrets } from '@clad/core'
import type { ToolContext, ToolDefinition } from './types.js'
import { createProvider } from './provider-factory.js'

// Import all tool handlers
import * as getBalances from './tools/clad_get_balances.js'
import * as getTransactions from './tools/clad_get_transactions.js'
import * as safeToSpend from './tools/clad_safe_to_spend.js'
import * as requestAction from './tools/clad_request_action.js'
import * as auditLog from './tools/clad_audit_log.js'

const tools: ToolDefinition[] = [getBalances, getTransactions, safeToSpend, requestAction, auditLog]

/**
 * Writes a diagnostic line to stderr with any error text redacted first.
 * Use this instead of a bare `process.stderr.write` whenever the message
 * embeds an error object or other value that could carry Plaid token or
 * secret material (e.g. axios errors embedding request headers/body).
 * Static literal messages don't need this.
 */
function writeRedactedStderr(message: string): void {
  process.stderr.write(redactSecrets(message))
}

/**
 * Handles a single `tools/call` request: dispatches to the matching tool
 * handler, records an audit trail entry, and redacts any secret material
 * before it can reach the audit DB, stderr, or the MCP client.
 *
 * Factored out of `main()` so it can be unit-tested without a stdio
 * transport — tests can call this directly with fake deps.
 */
export async function handleToolCall(
  request: CallToolRequest,
  deps: {
    tools: ToolDefinition[]
    agentId: string
    context: Omit<ToolContext, 'agentId'>
    auditLogger: AuditLogger
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { name, arguments: args } = request.params
  const tool = deps.tools.find(t => t.name === name)
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
  }

  const context: ToolContext = { agentId: deps.agentId, ...deps.context }

  try {
    const result = await tool.handler(args ?? {}, context)
    // Log to audit trail (redacted defense in depth — args shouldn't carry
    // secrets, but tool input is untrusted).
    deps.auditLogger.logRequest(deps.agentId, name, 'allow', redactSecrets(JSON.stringify(args)))
    return result
  } catch (error) {
    const redactedError = redactSecrets(String(error))
    deps.auditLogger.logRequest(deps.agentId, name, 'deny', redactedError)
    return { content: [{ type: 'text', text: `Error: ${redactedError}` }] }
  }
}

async function main() {
  process.stderr.write(`[clad server] starting (PID ${process.pid})\n`)

  const server = new Server(
    { name: 'clad', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  const policyPath = process.env.CLAD_POLICY_PATH ?? './policy.yaml'
  const auditDbPath = process.env.CLAD_AUDIT_DB ?? './audit.sqlite'
  const approvalDbPath = process.env.CLAD_APPROVAL_DB ?? './approvals.sqlite'
  // Agent ID resolution: CLI arg (CLAD_AGENT_ID_ARG) > env var > default
  // CLAD_AGENT_ID_ARG is set by `clad serve --agent-id` before spawning this process
  const agentId = process.env.CLAD_AGENT_ID_ARG ?? process.env.CLAD_AGENT_ID ?? 'default-agent'

  // Ensure parent directories exist for database files
  for (const dbPath of [auditDbPath, approvalDbPath]) {
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  process.stderr.write(`[clad server] loading policy from ${policyPath}\n`)
  const policy = await parsePolicy(policyPath)
  process.stderr.write(`[clad server] policy loaded (${Object.keys(policy.agents ?? {}).length} agents)\n`)
  const provider = await createProvider()
  const auditLogger = new AuditLogger(auditDbPath)
  const approvalQueue = new ApprovalQueue(approvalDbPath)

  // Validate agent ID exists in policy; warn to stderr (not stdout — MCP protocol)
  if (!(agentId in policy.agents)) {
    process.stderr.write(
      `[clad] Warning: agent "${agentId}" not found in policy. All requests will be denied.\n`
    )
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    handleToolCall(request, {
      tools,
      agentId,
      context: { policy, provider, auditLogger, approvalQueue },
      auditLogger,
    })
  )

  const transport = new StdioServerTransport()
  process.stderr.write(`[clad server] connecting stdio transport\n`)
  await server.connect(transport)
  process.stderr.write(`[clad server] MCP server ready\n`)
}

main().catch((err) => {
  writeRedactedStderr(`[clad server] fatal: ${err}\n`)
  process.exit(1)
})
