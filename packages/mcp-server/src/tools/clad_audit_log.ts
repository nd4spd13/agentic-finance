import { evaluate } from '@clad/core'
import type { ToolContext } from '../types.js'

export const name = 'clad_audit_log'
export const description = 'Query the audit log with filters'
export const inputSchema = {
  type: 'object' as const,
  properties: {
    agent_id: { type: 'string', description: 'Filter by agent ID (optional)' },
    tool_name: { type: 'string', description: 'Filter by tool name (optional)' },
    decision: { type: 'string', enum: ['allow', 'deny', 'escalate'], description: 'Filter by decision (optional)' },
    start_time: { type: 'string', description: 'Start time ISO format (optional)' },
    end_time: { type: 'string', description: 'End time ISO format (optional)' },
  },
  required: [],
}

export async function handler(
  args: { agent_id?: string; tool_name?: string; decision?: string; start_time?: string; end_time?: string },
  context: ToolContext
) {
  // Evaluate if agent has audit read permissions
  const result = await evaluate(context.agentId, {
    type: 'audit_request',
    resource: 'audit_log',
  }, context.policy, {})

  if (result.decision === 'deny') {
    return { content: [{ type: 'text', text: `Denied: ${result.reason}` }] }
  }

  const filters: Parameters<typeof context.auditLogger.getRecords>[0] = {}
  if (args.agent_id) filters.agent_id = args.agent_id
  if (args.tool_name) filters.tool_name = args.tool_name
  if (args.decision) filters.decision = args.decision
  if (args.start_time) filters.start_time = new Date(args.start_time)
  if (args.end_time) filters.end_time = new Date(args.end_time)

  const records = context.auditLogger.getRecords(filters)

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        count: records.length,
        records,
        chain_valid: context.auditLogger.verifyChain(),
      }, null, 2)
    }]
  }
}
