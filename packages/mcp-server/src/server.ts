import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { parsePolicy, DummyDataProvider, AuditLogger, ApprovalQueue } from '@clad/core'

// Import all tool handlers
import * as getBalances from './tools/clad_get_balances.js'
import * as getTransactions from './tools/clad_get_transactions.js'
import * as safeToSpend from './tools/clad_safe_to_spend.js'
import * as requestAction from './tools/clad_request_action.js'
import * as auditLog from './tools/clad_audit_log.js'

const tools = [getBalances, getTransactions, safeToSpend, requestAction, auditLog]

async function main() {
  const server = new Server(
    { name: 'clad', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  const policyPath = process.env.CLAD_POLICY_PATH ?? './policy.yaml'
  const auditDbPath = process.env.CLAD_AUDIT_DB ?? './audit.sqlite'
  const approvalDbPath = process.env.CLAD_APPROVAL_DB ?? './approvals.sqlite'

  const policy = await parsePolicy(policyPath)
  const provider = new DummyDataProvider()
  const auditLogger = new AuditLogger(auditDbPath)
  const approvalQueue = new ApprovalQueue(approvalDbPath)

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

    const agentId = 'default-agent' // In production, extract from auth context
    const context = { agentId, policy, provider, auditLogger, approvalQueue }

    try {
      const result = await (tool as any).handler(args as any, context as any)
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
