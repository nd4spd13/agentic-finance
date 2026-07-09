import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Account, Transaction } from '@clad/core'
import {
  epochSecondsToDateString,
  mapAccount,
  mapAccountId,
  mapAccountSet,
  mapAccountType,
  mapTransaction,
  mapTransactionId,
  parseSimpleFinAmount,
  resolveConnection,
  SimpleFinMappingError,
  type SimpleFinAccountSetDto,
} from '../src/mapping.js'

function loadFixture(name: string): SimpleFinAccountSetDto {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf-8')) as SimpleFinAccountSetDto
}

const plainFixture = loadFixture('accounts-v2-plain.json')
const balancesOnlyFixture = loadFixture('accounts-v2-balances-only.json')
const pendingWindowFixture = loadFixture('accounts-v2-pending-window.json')
const currencyUrlFixture = loadFixture('synthetic-currency-url.json')
const pendingFixture = loadFixture('synthetic-pending.json')
const multiConnectionFixture = loadFixture('synthetic-multi-connection.json')

describe('parseSimpleFinAmount', () => {
  it('parses a plain positive decimal string', () => {
    expect(parseSimpleFinAmount('114405.51')).toBe(114405.51)
  })

  it('parses a signed negative decimal string', () => {
    expect(parseSimpleFinAmount('-45.50')).toBe(-45.5)
  })

  it('parses a whole-number string with no decimal point', () => {
    expect(parseSimpleFinAmount('40')).toBe(40)
  })

  it('parses "0.00" as a plain positive zero', () => {
    expect(parseSimpleFinAmount('0.00')).toBe(0)
    expect(Object.is(parseSimpleFinAmount('0.00'), -0)).toBe(false)
  })

  it('normalizes "-0.00" to positive zero rather than negative zero', () => {
    const value = parseSimpleFinAmount('-0.00')
    expect(value).toBe(0)
    expect(Object.is(value, -0)).toBe(false)
  })

  it('trims surrounding whitespace', () => {
    expect(parseSimpleFinAmount('  5.25  ')).toBe(5.25)
  })

  it('supports more than two fractional digits without precision loss via floats', () => {
    expect(parseSimpleFinAmount('1.005')).toBeCloseTo(1.005, 10)
  })

  it.each(['abc', '', '1e10', 'NaN', 'Infinity', '1.2.3', '$5.00', '5,000.00', '--5.00'])(
    'rejects malformed decimal string %j instead of silently coercing it',
    (bad) => {
      expect(() => parseSimpleFinAmount(bad)).toThrow(SimpleFinMappingError)
    }
  )

  it('never calls Number()/parseFloat() permissive-parse shortcuts (regression: exponential notation)', () => {
    // Number("1e10") and parseFloat("1e10") both succeed silently (=1e10);
    // a correct implementation must reject it instead.
    expect(() => parseSimpleFinAmount('1e10')).toThrow()
  })
})

describe('mapAccountId / mapTransactionId', () => {
  it('namespaces account ids as simplefin:{id}', () => {
    expect(mapAccountId('fixture-acct-savings')).toBe('simplefin:fixture-acct-savings')
  })

  it('namespaces transaction ids scoped to their account (accountId:txnId)', () => {
    expect(mapTransactionId('fixture-acct-savings', '1781069242')).toBe(
      'simplefin:fixture-acct-savings:1781069242'
    )
  })

  it('produces distinct transaction ids for the same raw txn id under different accounts', () => {
    // accounts-v2-pending-window.json: fixture-acct-savings and
    // fixture-acct-checking both contain a raw transaction id "1781069242".
    const a = mapTransactionId('fixture-acct-savings', '1781069242')
    const b = mapTransactionId('fixture-acct-checking', '1781069242')
    expect(a).not.toBe(b)
  })
})

describe('mapAccountType', () => {
  it.each([
    ['SimpleFIN Savings', 'savings'],
    ['SimpleFIN Checking', 'checking'],
    ['SimpleFIN Empty Account', 'checking'],
    ['My Brokerage Investment Account', 'investment'],
    ['Visa Credit Card', 'credit'],
    ['Auto Loan', 'loan'],
    ['Home Mortgage', 'loan'],
  ] as const)('maps account name %j to type %j', (name, expected) => {
    expect(mapAccountType(name)).toBe(expected)
  })
})

describe('resolveConnection', () => {
  const connections = multiConnectionFixture.connections ?? []

  it('resolves a matching conn_id', () => {
    expect(resolveConnection('fixture-conn-bank-a', connections)?.org_name).toBe(
      'Bank A Financial'
    )
  })

  it('returns undefined for an unresolvable conn_id', () => {
    expect(resolveConnection('fixture-conn-does-not-exist', connections)).toBeUndefined()
  })

  it('returns undefined when conn_id itself is undefined', () => {
    expect(resolveConnection(undefined, connections)).toBeUndefined()
  })
})

describe('mapAccount (real fixtures)', () => {
  it('maps the savings account from accounts-v2-plain.json end to end', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-savings')!
    const mapped = mapAccount(raw, plainFixture.connections)

    const expected: Account = {
      id: 'simplefin:fixture-acct-savings',
      name: 'SimpleFIN Savings',
      type: 'savings',
      subtype: 'SimpleFIN Bridge',
      mask: undefined,
      balance_current: 114405.51,
      balance_available: 114405.51,
      currency: 'USD',
    }
    expect(mapped).toEqual(expected)
  })

  it('maps the checking account, resolving conn_id -> connections for subtype', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-checking')!
    const mapped = mapAccount(raw, plainFixture.connections)
    expect(mapped.type).toBe('checking')
    expect(mapped.subtype).toBe('SimpleFIN Bridge')
    expect(mapped.balance_current).toBe(24668.87)
  })

  it('maps the zero-balance empty account', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-empty')!
    const mapped = mapAccount(raw, plainFixture.connections)
    expect(mapped.balance_current).toBe(0)
    expect(mapped.balance_available).toBe(0)
  })

  it('ignores holdings entirely (no field on the mapped Account)', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-savings')!
    expect(raw.holdings?.length).toBeGreaterThan(0) // sanity: fixture really has holdings
    const mapped = mapAccount(raw, plainFixture.connections)
    expect(mapped).not.toHaveProperty('holdings')
  })

  it('tolerates balances-only accounts (transactions/holdings present as empty arrays)', () => {
    for (const raw of balancesOnlyFixture.accounts) {
      expect(() => mapAccount(raw, balancesOnlyFixture.connections)).not.toThrow()
    }
  })

  it('passes a custom-currency URL through unchanged', () => {
    const raw = currencyUrlFixture.accounts[0]!
    const mapped = mapAccount(raw, currencyUrlFixture.connections)
    expect(mapped.currency).toBe('https://simplefin.org/currencies/fixture-custom-token')
  })

  it('resolves subtype independently per connection in a multi-institution response', () => {
    const bankA = multiConnectionFixture.accounts.find((a) => a.id === 'fixture-acct-bank-a')!
    const bankB = multiConnectionFixture.accounts.find((a) => a.id === 'fixture-acct-bank-b')!
    expect(mapAccount(bankA, multiConnectionFixture.connections).subtype).toBe('Bank A Financial')
    expect(mapAccount(bankB, multiConnectionFixture.connections).subtype).toBe('Bank B Trust')
  })

  it('tolerates an unresolvable conn_id, leaving subtype undefined rather than throwing', () => {
    const orphan = multiConnectionFixture.accounts.find(
      (a) => a.id === 'fixture-acct-unresolvable'
    )!
    const mapped = mapAccount(orphan, multiConnectionFixture.connections)
    expect(mapped.subtype).toBeUndefined()
  })
})

describe('mapTransaction (real fixtures)', () => {
  it('does not negate the SimpleFIN amount (SimpleFIN and core both use negative=outflow)', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-savings')!
      .transactions![0]!
    expect(raw.amount).toBe('-40.00')
    const mapped = mapTransaction(raw, 'fixture-acct-savings')
    expect(mapped.amount).toBe(-40)
  })

  it('namespaces id and account_id', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-savings')!
      .transactions![0]!
    const mapped = mapTransaction(raw, 'fixture-acct-savings')
    expect(mapped.id).toBe('simplefin:fixture-acct-savings:1783497600')
    expect(mapped.account_id).toBe('simplefin:fixture-acct-savings')
  })

  it('prefers transacted_at over posted for date, converted from epoch seconds', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-savings')!
      .transactions![0]!
    expect(raw.transacted_at).toBe(1783497600)
    const mapped = mapTransaction(raw, 'fixture-acct-savings')
    expect(mapped.date).toBe('2026-07-08')
  })

  it('falls back to posted when transacted_at is absent', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-savings')!
      .transactions![0]!
    const withoutTransactedAt = { ...raw }
    delete withoutTransactedAt.transacted_at
    const mapped = mapTransaction(withoutTransactedAt, 'fixture-acct-savings')
    expect(mapped.date).toBe(epochSecondsToDateString(raw.posted))
  })

  it('maps payee to merchant_name and description through', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-savings')!
      .transactions![0]!
    const mapped = mapTransaction(raw, 'fixture-acct-savings')
    expect(mapped.description).toBe('Fishing bait')
    expect(mapped.merchant_name).toBe("John's Fishin Shack")
  })

  it('defaults pending to false when the field is absent (never observed live)', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-savings')!
      .transactions![0]!
    expect(raw.pending).toBeUndefined()
    expect(mapTransaction(raw, 'fixture-acct-savings').pending).toBe(false)
  })

  it('leaves category undefined (SimpleFIN has no category taxonomy)', () => {
    const raw = plainFixture.accounts.find((a) => a.id === 'fixture-acct-savings')!
      .transactions![0]!
    expect(mapTransaction(raw, 'fixture-acct-savings').category).toBeUndefined()
  })
})

describe('mapTransaction (synthetic-pending.json)', () => {
  it('maps pending:true through as a strict boolean', () => {
    const raw = pendingFixture.accounts[0]!.transactions![0]!
    expect(raw.pending).toBe(true)
    const mapped = mapTransaction(raw, pendingFixture.accounts[0]!.id)
    expect(mapped.pending).toBe(true)
  })

  it('maps a positive-amount (inflow) transaction to a positive core amount, unnegated', () => {
    const raw = pendingFixture.accounts[0]!.transactions![1]!
    expect(raw.amount).toBe('1500.00')
    const mapped = mapTransaction(raw, pendingFixture.accounts[0]!.id)
    expect(mapped.amount).toBe(1500)
  })
})

describe('mapAccountSet (real fixtures, end to end)', () => {
  it('maps all three accounts and every transaction from accounts-v2-plain.json', () => {
    const { accounts, transactions } = mapAccountSet(plainFixture)
    expect(accounts).toHaveLength(3)
    expect(accounts.map((a) => a.id)).toEqual([
      'simplefin:fixture-acct-savings',
      'simplefin:fixture-acct-checking',
      'simplefin:fixture-acct-empty',
    ])
    // 4 savings + 4 checking + 0 empty
    expect(transactions).toHaveLength(8)
  })

  it('maps accounts-v2-balances-only.json with zero transactions', () => {
    const { accounts, transactions } = mapAccountSet(balancesOnlyFixture)
    expect(accounts).toHaveLength(3)
    expect(transactions).toHaveLength(0)
  })

  it('maps every transaction from accounts-v2-pending-window.json with no id collisions', () => {
    // This fixture is the one where fixture-acct-savings and
    // fixture-acct-checking share identical raw transaction ids -- the
    // real-world case mapTransactionId's account-scoping exists to handle.
    const { accounts, transactions } = mapAccountSet(pendingWindowFixture)
    expect(accounts).toHaveLength(3)
    expect(transactions).toHaveLength(16) // 8 savings + 8 checking + 0 empty

    const ids = transactions.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every mapped transaction references an account_id present in the mapped accounts', () => {
    const { accounts, transactions } = mapAccountSet(pendingWindowFixture)
    const accountIds = new Set(accounts.map((a) => a.id))
    for (const txn of transactions) {
      expect(accountIds.has(txn.account_id)).toBe(true)
    }
  })

  it('typechecks against @clad/core models', () => {
    const { accounts, transactions } = mapAccountSet(plainFixture)
    const typedAccounts: Account[] = accounts
    const typedTransactions: Transaction[] = transactions
    expect(typedAccounts.length).toBeGreaterThan(0)
    expect(typedTransactions.length).toBeGreaterThan(0)
  })
})

describe('mapAccountSet (synthetic fixtures)', () => {
  it('maps the multi-connection fixture, resolving each account against the right institution', () => {
    const { accounts } = mapAccountSet(multiConnectionFixture)
    const byId = new Map(accounts.map((a) => [a.id, a]))
    expect(byId.get('simplefin:fixture-acct-bank-a')?.subtype).toBe('Bank A Financial')
    expect(byId.get('simplefin:fixture-acct-bank-b')?.subtype).toBe('Bank B Trust')
    expect(byId.get('simplefin:fixture-acct-unresolvable')?.subtype).toBeUndefined()
  })
})
