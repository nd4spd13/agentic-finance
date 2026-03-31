import { evaluate, type PolicyConfig, type DataProvider, type ApprovalQueue } from '@clad/core'

export const name = 'clad_request_action'
export const description = 'Request a spending action, evaluated by policy → allow/deny/escalate'
export const inputSchema = {
  type: 'object' as const,
  properties: {
    amount: { type: 'number', description: 'Transaction amount' },
    merchant: { type: 'string', description: 'Merchant name' },
    category: { type: 'string', description: 'Transaction category' },
    description: { type: 'string', description: 'Transaction description (optional)' },
  },
  required: ['amount', 'merchant', 'category'],
}

export interface Context {
  agentId: string
  policy: PolicyConfig
  provider: DataProvider
  approvalQueue: ApprovalQueue
}

export async function handler(
  args: { amount: number; merchant: string; category: string; description?: string },
  context: Context
) {
  const result = await evaluate(context.agentId, {
    type: 'spending_request',
    amount: args.amount,
    merchant: args.merchant,
    category: args.category,
  }, context.policy, {})

  if (result.decision === 'deny') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          decision: 'deny',
          reason: result.reason,
          policy_rule: result.policy_rule,
        }, null, 2)
      }]
    }
  }

  if (result.decision === 'escalate') {
    const approval = context.approvalQueue.createApproval(
      context.agentId,
      'clad_request_action',
      result.reason
    )
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          decision: 'escalate',
          reason: result.reason,
          approval_id: approval.id,
          status: approval.status,
          expires_at: approval.expires_at,
        }, null, 2)
      }]
    }
  }

  // decision === 'allow'
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        decision: 'allow',
        reason: result.reason,
        amount: args.amount,
        merchant: args.merchant,
        category: args.category,
      }, null, 2)
    }]
  }
}
