import { evaluate } from '@clad/core'
import type { ToolContext } from '../types.js'

export const name = 'clad_get_balances'
export const description = 'Get account balances filtered by agent policy'
export const inputSchema = {
  type: 'object' as const,
  properties: {
    account_type: { type: 'string', description: 'Account type filter (e.g. "checking", "savings", "credit"). Optional — returns all accounts if omitted.' },
  },
  required: [] as string[],
}

export async function handler(
  args: { account_type?: string },
  context: ToolContext
) {
  const result = await evaluate(context.agentId, {
    type: 'data_request',
    resource: 'balance',
  }, context.policy, {})

  if (result.decision === 'deny') {
    return { content: [{ type: 'text', text: `Denied: ${result.reason}` }] }
  }

  const accounts = await context.provider.getAccounts(context.agentId)
  const filtered = accounts.filter(a => !args.account_type || a.type === args.account_type)

  const balances = await Promise.all(
    filtered.map(a => context.provider.getBalance(context.agentId, a.id))
  )

  return { content: [{ type: 'text', text: JSON.stringify(balances, null, 2) }] }
}
