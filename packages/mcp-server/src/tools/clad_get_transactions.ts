import { evaluate, type TransactionQueryOpts } from '@clad/core'
import type { ToolContext } from '../types.js'
import { denyIfAccountNotVisible } from './account-visibility-guard.js'

export const name = 'clad_get_transactions'
export const description = 'Get transactions with policy-based redaction'
export const inputSchema = {
  type: 'object' as const,
  properties: {
    account_id: { type: 'string', description: 'Account ID (e.g. "acc_checking_001")' },
    start_date: { type: 'string', description: 'Start date (YYYY-MM-DD, optional)' },
    end_date: { type: 'string', description: 'End date (YYYY-MM-DD, optional)' },
    count: { type: 'number', description: 'Number of transactions to fetch (optional)' },
  },
  required: ['account_id'],
}

export async function handler(
  args: { account_id: string; start_date?: string; end_date?: string; count?: number },
  context: ToolContext
) {
  const result = await evaluate(context.agentId, {
    type: 'data_request',
    resource: 'transactions',
  }, context.policy, {})

  if (result.decision === 'deny') {
    return { content: [{ type: 'text', text: `Denied: ${result.reason}` }] }
  }

  const visibilityDenial = await denyIfAccountNotVisible(context, args.account_id)
  if (visibilityDenial) {
    return visibilityDenial
  }

  const opts: TransactionQueryOpts = {}
  if (args.start_date) opts.start_date = args.start_date
  if (args.end_date) opts.end_date = args.end_date
  if (args.count) opts.count = args.count

  const transactions = await context.provider.getTransactions(context.agentId, args.account_id, opts)

  return { content: [{ type: 'text', text: JSON.stringify(transactions, null, 2) }] }
}
