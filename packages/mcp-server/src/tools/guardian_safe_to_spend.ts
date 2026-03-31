import { evaluate, type PolicyConfig, type DataProvider } from '@guardian-layer/core'

export const name = 'guardian_safe_to_spend'
export const description = 'Compute safe-to-spend amount using balance and recurring charges'
export const inputSchema = {
  type: 'object' as const,
  properties: {
    user_id: { type: 'string', description: 'User ID' },
    account_id: { type: 'string', description: 'Account ID' },
  },
  required: ['user_id', 'account_id'],
}

export interface Context {
  agentId: string
  policy: PolicyConfig
  provider: DataProvider
}

export async function handler(
  args: { user_id: string; account_id: string },
  context: Context
) {
  const result = await evaluate(context.agentId, {
    type: 'data_request',
    resource: 'balance',
  }, context.policy, {})

  if (result.decision === 'deny') {
    return { content: [{ type: 'text', text: `Denied: ${result.reason}` }] }
  }

  const balance = await context.provider.getBalance(args.user_id, args.account_id)

  // Calculate upcoming recurring charges for next 30 days
  let recurringAmount = 0
  if (context.provider.getRecurringCharges) {
    const charges = await context.provider.getRecurringCharges(args.user_id, args.account_id)
    // Sum charges due within next 30 days
    const now = new Date()
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    recurringAmount = charges
      .filter(c => new Date(c.next_date) <= thirtyDaysFromNow)
      .reduce((sum, c) => sum + c.amount, 0)
  }

  const safeToSpend = (balance.available || balance.current) - recurringAmount

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        account_id: args.account_id,
        current_balance: balance.current,
        available_balance: balance.available || balance.current,
        upcoming_recurring_charges_30d: recurringAmount,
        safe_to_spend: Math.max(0, safeToSpend),
        currency: balance.currency,
      }, null, 2)
    }]
  }
}
