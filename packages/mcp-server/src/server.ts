import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { parsePolicy, DummyDataProvider, AuditLogger, ApprovalQueue } from '@clad/core'
import type { ToolDefinition } from './types.js'

// Import all tool handlers
import * as getBalances from './tools/clad_get_balances.js'
import * as getTransactions from './tools/clad_get_transactions.js'
import * as safeToSpend from './tools/clad_safe_to_spend.js'
import * as requestAction from './tools/clad_request_action.js'
import * as auditLog from './tools/clad_audit_log.js'

const tools: ToolDefinition[] = [getBalances, getTransactions, safeToSpend, requestAction, auditLog]

async function main() {
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

  const policy = await parsePolicy(policyPath)
  const provider = new DummyDataProvider()
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const tool = tools.find(t => t.name === name)
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
    }

    const context = { agentId, policy, provider, auditLogger, approvalQueue }

    try {
      const result = await tool.handler(args ?? {}, context)
      // Log to audit trail
      auditLogger.logRequest(agentId, name, 'allow', JSON.stringify(args))
      return result
    } catch (error) {
      auditLogger.logRequest(agentId, name, 'deny', String(error))
      return { content: [{ type: 'text', text: `Error: ${error}` }] }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
