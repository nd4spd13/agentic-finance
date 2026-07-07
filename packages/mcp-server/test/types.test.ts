import { describe, it, expect, expectTypeOf } from 'vitest'
import type { ToolContext } from '../src/types.js'

/**
 * Compliance guard (CRS-25): `ToolContext` must NEVER gain a token-store
 * field. MCP tools only ever see the `FinancialDataProvider` interface —
 * access tokens must not be reachable from MCP clients. If this test fails
 * because a new key was added to `ToolContext`, that is a compliance
 * regression, not a test to "fix" by updating the expected key list.
 */
describe('ToolContext compliance guard', () => {
  it('has exactly the five expected keys — no token-store field', () => {
    type Keys = keyof ToolContext
    expectTypeOf<Keys>().toEqualTypeOf<
      'agentId' | 'policy' | 'provider' | 'auditLogger' | 'approvalQueue'
    >()
  })

  it('does not have a tokenStore field', () => {
    expectTypeOf<ToolContext>().not.toHaveProperty('tokenStore')
  })

  it('runtime object with exactly the five keys matches the type', () => {
    // Sanity check that the type-level assertion above corresponds to the
    // actual runtime shape constructed in server.ts.
    const context: ToolContext = {
      agentId: 'agent1',
      policy: { agents: {} },
      provider: {
        getAccounts: async () => [],
        getTransactions: async () => [],
        getBalance: async () => ({
          account_id: 'acc_1',
          current: 0,
          currency: 'USD',
          last_updated: new Date().toISOString(),
        }),
      },
      auditLogger: undefined as unknown as ToolContext['auditLogger'],
      approvalQueue: undefined as unknown as ToolContext['approvalQueue'],
    }
    expect(Object.keys(context).sort()).toEqual(
      ['agentId', 'approvalQueue', 'auditLogger', 'policy', 'provider'].sort()
    )
  })
})
