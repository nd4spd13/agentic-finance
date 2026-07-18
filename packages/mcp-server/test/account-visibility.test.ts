/**
 * CLAD-1 / CLAD-3 coverage: `clad_get_balances` returning redacted Account
 * objects (not raw `Balance[]`) subject to `AccountPermissions`, and the
 * `accounts.visible` bypass fix for `clad_get_transactions` /
 * `clad_safe_to_spend` (both previously accepted an arbitrary `account_id`
 * with no visibility check).
 */
import { describe, it, expect } from 'vitest'
import type { Account, FinancialDataProvider, PolicyConfig, Transaction } from '@clad/core'
import * as getBalances from '../src/tools/clad_get_balances.js'
import * as getTransactions from '../src/tools/clad_get_transactions.js'
import * as safeToSpend from '../src/tools/clad_safe_to_spend.js'
import type { ToolContext } from '../src/types.js'

function makeProvider(accounts: Account[]): FinancialDataProvider {
  return {
    async getAccounts() {
      return accounts
    },
    async getTransactions(_userId: string, accountId: string): Promise<Transaction[]> {
      if (!accounts.some((a) => a.id === accountId)) {
        return []
      }
      return [
        {
          id: `txn_${accountId}`,
          account_id: accountId,
          amount: -10,
          date: '2026-01-01',
          description: 'test transaction',
          pending: false,
        },
      ]
    },
    async getBalance(_userId: string, accountId: string) {
      const account = accounts.find((a) => a.id === accountId)
      if (!account) {
        throw new Error(`Account ${accountId} not found`)
      }
      return {
        account_id: accountId,
        current: account.balance_current,
        available: account.balance_available,
        currency: account.currency,
        last_updated: new Date().toISOString(),
      }
    },
  }
}

function makeContext(provider: FinancialDataProvider, policy: PolicyConfig, agentId = 'test-agent'): ToolContext {
  return { agentId, policy, provider } as ToolContext
}

const CHECKING_WITH_INSTITUTION: Account = {
  id: 'acc_checking_1',
  name: 'Primary Checking',
  type: 'checking',
  institution: 'Bank A',
  mask: '4321',
  balance_current: 500,
  balance_available: 450,
  currency: 'USD',
}

const SAVINGS_ACCOUNT: Account = {
  id: 'acc_savings_1',
  name: 'Rainy Day Savings',
  type: 'savings',
  institution: 'Bank B',
  mask: '9999',
  balance_current: 10000,
  balance_available: 10000,
  currency: 'USD',
}

describe('clad_get_balances — redacted Account shape (CLAD-1)', () => {
  it('(a) includes name and institution by default, and omits mask when account_number is not granted', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: [] } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION]), policy)

    const result = await getBalances.handler({}, context)
    const [account] = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>

    expect(account.account_id).toBe('acc_checking_1')
    expect(account.name).toBe('Primary Checking')
    expect(account.institution).toBe('Bank A')
    expect(account.current).toBe(500)
    expect(account.available).toBe(450)
    expect(account).not.toHaveProperty('mask')
  })

  it('(b) includes mask when account_number permission is explicitly true', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: [], account_number: true } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION]), policy)

    const result = await getBalances.handler({}, context)
    const [account] = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>

    expect(account.mask).toBe('4321')
  })

  it('(c) suppresses name and institution when explicitly disabled', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: [], name: false, institution: false } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION]), policy)

    const result = await getBalances.handler({}, context)
    const [account] = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>

    expect(account).not.toHaveProperty('name')
    expect(account).not.toHaveProperty('institution')
    // Balance data is unaffected by the name/institution toggles.
    expect(account.current).toBe(500)
  })

  it('(d) filters by account id in the visible list', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: ['acc_checking_1'] } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION, SAVINGS_ACCOUNT]), policy)

    const result = await getBalances.handler({}, context)
    const accounts = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>

    expect(accounts).toHaveLength(1)
    expect(accounts[0].account_id).toBe('acc_checking_1')
  })

  it('(d) filters by account type in the visible list', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: ['savings'] } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION, SAVINGS_ACCOUNT]), policy)

    const result = await getBalances.handler({}, context)
    const accounts = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>

    expect(accounts).toHaveLength(1)
    expect(accounts[0].account_id).toBe('acc_savings_1')
  })

  it('(f) still applies the account_type argument filter on top of visible[]', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: ['checking', 'savings'] } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION, SAVINGS_ACCOUNT]), policy)

    const result = await getBalances.handler({ account_type: 'checking' }, context)
    const accounts = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>

    expect(accounts).toHaveLength(1)
    expect(accounts[0].account_id).toBe('acc_checking_1')
  })

  it('(f) denies via the evaluator when account_type is outside a pure-type visible list', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: ['savings'] } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION, SAVINGS_ACCOUNT]), policy)

    const result = await getBalances.handler({ account_type: 'checking' }, context)

    expect(result.content[0].text).toContain('Denied')
    expect(result.content[0].text).toContain('not in visible list')
  })
})

describe('clad_get_transactions — visible[] bypass fix (CLAD-3)', () => {
  it('(e) denies a request for an account_id outside the visible list', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: {
            accounts: { visible: ['acc_checking_1'] },
            transactions: { read: true },
          },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION, SAVINGS_ACCOUNT]), policy)

    const result = await getTransactions.handler({ account_id: 'acc_savings_1' }, context)

    expect(result.content[0].text).toContain('Denied')
    expect(result.content[0].text).toContain('acc_savings_1')
    expect(result.content[0].text).toContain("not in this agent's visible accounts")
  })

  it('(e) denies a request for an account_id that does not exist at all (not an existence oracle)', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: {
            accounts: { visible: ['acc_checking_1'] },
            transactions: { read: true },
          },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION]), policy)

    const result = await getTransactions.handler({ account_id: 'acc_does_not_exist' }, context)

    expect(result.content[0].text).toContain('Denied')
    expect(result.content[0].text).toContain("not in this agent's visible accounts")
  })

  it('allows a request for an account_id inside the visible list', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: {
            accounts: { visible: ['acc_checking_1'] },
            transactions: { read: true },
          },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION, SAVINGS_ACCOUNT]), policy)

    const result = await getTransactions.handler({ account_id: 'acc_checking_1' }, context)
    const transactions = JSON.parse(result.content[0].text) as Array<{ account_id: string }>

    expect(transactions).toHaveLength(1)
    expect(transactions[0].account_id).toBe('acc_checking_1')
  })
})

describe('clad_safe_to_spend — visible[] bypass fix (CLAD-3)', () => {
  it('(e) denies a request for an account_id outside the visible list', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: ['acc_checking_1'], balance: true } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION, SAVINGS_ACCOUNT]), policy)

    const result = await safeToSpend.handler({ account_id: 'acc_savings_1' }, context)

    expect(result.content[0].text).toContain('Denied')
    expect(result.content[0].text).toContain("not in this agent's visible accounts")
  })

  it('(e) denies a request for an account_id that does not exist at all (not an existence oracle)', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: ['acc_checking_1'], balance: true } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION]), policy)

    const result = await safeToSpend.handler({ account_id: 'acc_does_not_exist' }, context)

    expect(result.content[0].text).toContain('Denied')
    expect(result.content[0].text).toContain("not in this agent's visible accounts")
  })

  it('allows and computes safe-to-spend for an account_id inside the visible list', async () => {
    const policy: PolicyConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          permissions: { accounts: { visible: ['acc_checking_1'], balance: true } },
        },
      },
    }
    const context = makeContext(makeProvider([CHECKING_WITH_INSTITUTION, SAVINGS_ACCOUNT]), policy)

    const result = await safeToSpend.handler({ account_id: 'acc_checking_1' }, context)
    const parsed = JSON.parse(result.content[0].text) as { safe_to_spend: number; account_id: string }

    expect(parsed.account_id).toBe('acc_checking_1')
    expect(parsed.safe_to_spend).toBe(450)
  })
})
