import { filterVisibleAccounts } from '@clad/core'
import type { ToolContext } from '../types.js'

/**
 * Verifies that `accountId` is among the agent's policy-visible accounts
 * (per `accounts.visible` — see `filterVisibleAccounts`), for tools like
 * `clad_get_transactions` and `clad_safe_to_spend` that accept an arbitrary
 * `account_id` argument. Without this check, an agent could pass any
 * account id and read data for accounts outside its visible list, bypassing
 * the same policy `clad_get_balances` already enforces.
 *
 * Returns a `Denied` tool response (same shape as the `evaluate()` deny
 * path) when the account is not visible — this includes account ids that
 * don't exist at all, so the response can't be used as an existence oracle
 * for account ids outside the agent's grant. Returns `null` when the
 * account is visible and the caller should proceed.
 */
export async function denyIfAccountNotVisible(
  context: ToolContext,
  accountId: string
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  const accountPermissions = context.policy.agents[context.agentId]?.permissions?.accounts
  const accounts = await context.provider.getAccounts(context.agentId)
  const visible = filterVisibleAccounts(accounts, accountPermissions?.visible)

  if (!visible.some((a) => a.id === accountId)) {
    return {
      content: [{
        type: 'text',
        text: `Denied: account "${accountId}" is not in this agent's visible accounts`,
      }],
    }
  }

  return null
}
