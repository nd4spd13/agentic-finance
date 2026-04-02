import { evaluate } from '@clad/core'
import type { ToolContext } from '../types.js'

export const name = 'clad_get_balances'
export const description = 'Get account balances filtered by agent policy'
export const inputSchema = {
  type: 'object' as const,
  properties: {
    user_id: { type: 'string', description: 'User ID' },
    account_type: { type: 'string', description: 'Account type filter (optional)' },
  },
  required: ['user_id'],
}

export async function handler(
  args: { user_id: string; account_type?: string },
  context: ToolContext
) {
  const result = await evaluate(context.agentId, {
    type: 'data_request',
    resource: 'balance',
  }, context.policy, {})

  if (result.decision === 'deny') {
    return { content: [{ type: 'text', text: `Denied: ${result.reason}` }] }
  }

  const accounts = await context.provider.getAccounts(args.user_id)
  const filtered = accounts.filter(a => !args.account_type || a.type === args.account_type)

  const balances = await Promise.all(
    filtered.map(a => context.provider.getBalance(args.user_id, a.id))
  )

  return { content: [{ type: 'text', text: JSON.stringify(balances, null, 2) }] }
}
