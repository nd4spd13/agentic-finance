import type { PolicyConfig, DataProvider, AuditLogger, ApprovalQueue } from '@clad/core'

export interface ToolContext {
  agentId: string
  policy: PolicyConfig
  provider: DataProvider
  auditLogger: AuditLogger
  approvalQueue: ApprovalQueue
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
  handler(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<{ content: Array<{ type: string; text: string }> }>
}
