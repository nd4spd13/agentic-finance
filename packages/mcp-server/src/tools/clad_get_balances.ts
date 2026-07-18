import { evaluate, filterVisibleAccounts, redactAccount } from '@clad/core'
import type { ToolContext } from '../types.js'

export const name = 'clad_get_balances'
export const description =
  'Get accounts (with current/available balances and metadata such as name, type, institution, and mask) filtered by agent policy — name/institution are included unless explicitly hidden, mask is included only when the account_number permission is explicitly granted'
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
    account_type: args.account_type,
  }, context.policy, {})

  if (result.decision === 'deny') {
    return { content: [{ type: 'text', text: `Denied: ${result.reason}` }] }
  }

  const accountPermissions = context.policy.agents[context.agentId]?.permissions?.accounts

  const accounts = await context.provider.getAccounts(context.agentId)
  const visible = filterVisibleAccounts(accounts, accountPermissions?.visible)
  const filtered = visible.filter(a => !args.account_type || a.type === args.account_type)
  const redacted = filtered.map(a => redactAccount(a, accountPermissions))

  return { content: [{ type: 'text', text: JSON.stringify(redacted, null, 2) }] }
}
