import { evaluate } from '@clad/core'
import type { ToolContext } from '../types.js'
import { denyIfAccountNotVisible } from './account-visibility-guard.js'

export const name = 'clad_safe_to_spend'
export const description = 'Compute safe-to-spend amount using balance and recurring charges'
export const inputSchema = {
  type: 'object' as const,
  properties: {
    account_id: { type: 'string', description: 'Account ID (e.g. "acc_checking_001")' },
  },
  required: ['account_id'],
}

export async function handler(
  args: { account_id: string },
  context: ToolContext
) {
  const result = await evaluate(context.agentId, {
    type: 'data_request',
    resource: 'balance',
  }, context.policy, {})

  if (result.decision === 'deny') {
    return { content: [{ type: 'text', text: `Denied: ${result.reason}` }] }
  }

  const visibilityDenial = await denyIfAccountNotVisible(context, args.account_id)
  if (visibilityDenial) {
    return visibilityDenial
  }

  const balance = await context.provider.getBalance(context.agentId, args.account_id)

  // Calculate upcoming recurring charges for next 30 days
  let recurringAmount = 0
  if (context.provider.getRecurringCharges) {
    const charges = await context.provider.getRecurringCharges(context.agentId, args.account_id)
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
