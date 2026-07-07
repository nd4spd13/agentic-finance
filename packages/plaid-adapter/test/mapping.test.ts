import { describe, expect, it } from 'vitest'
import type { TransactionStream } from 'plaid'
import {
  mapAccount,
  mapAccountType,
  mapRecurringCharge,
  mapTransaction,
} from '../src/mapping.js'
import {
  checkingAccount,
  creditAccount,
  investmentAccount,
  loanAccount,
  savingsAccount,
  unknownTypeAccount,
} from './fixtures/accounts.js'
import { makePlaidTransaction } from './fixtures/transactions.js'

describe('mapAccountType', () => {
  it('maps depository/checking to checking', () => {
    expect(mapAccountType('depository', 'checking')).toBe('checking')
  })

  it('maps depository/savings to savings', () => {
    expect(mapAccountType('depository', 'savings')).toBe('savings')
  })

  it('maps credit to credit', () => {
    expect(mapAccountType('credit', 'credit card')).toBe('credit')
  })

  it('maps loan to loan', () => {
    expect(mapAccountType('loan', 'student')).toBe('loan')
  })

  it('maps investment to investment', () => {
    expect(mapAccountType('investment', 'brokerage')).toBe('investment')
  })

  it('maps brokerage to investment', () => {
    expect(mapAccountType('brokerage', 'brokerage')).toBe('investment')
  })

  it('falls back to checking for unknown types', () => {
    expect(mapAccountType('other', 'other')).toBe('checking')
  })
})

describe('mapAccount', () => {
  it('maps a checking account end to end, preserving subtype/mask/currency', () => {
    const mapped = mapAccount(checkingAccount)
    expect(mapped).toEqual({
      id: 'plaid_acc_checking',
      name: 'Plaid Checking',
      type: 'checking',
      subtype: 'checking',
      mask: '1111',
      balance_current: 1000.5,
      balance_available: 950.25,
      currency: 'USD',
    })
  })

  it('maps a savings account', () => {
    expect(mapAccount(savingsAccount).type).toBe('savings')
  })

  it('maps a credit account', () => {
    expect(mapAccount(creditAccount).type).toBe('credit')
    expect(mapAccount(creditAccount).balance_current).toBe(-410.75)
  })

  it('maps a loan account', () => {
    expect(mapAccount(loanAccount).type).toBe('loan')
  })

  it('maps an investment/brokerage account', () => {
    expect(mapAccount(investmentAccount).type).toBe('investment')
  })

  it('maps an unrecognized type to the nearest core type, preserving the raw subtype', () => {
    const mapped = mapAccount(unknownTypeAccount)
    expect(mapped.type).toBe('checking')
    expect(mapped.subtype).toBe('other')
  })

  it('defaults balance_current to 0 when Plaid returns null', () => {
    const mapped = mapAccount({
      ...loanAccount,
      balances: { ...loanAccount.balances, current: null },
    })
    expect(mapped.balance_current).toBe(0)
  })
})

describe('mapTransaction', () => {
  it('negates the Plaid amount (Plaid positive=outflow -> core negative=outflow)', () => {
    const mapped = mapTransaction(makePlaidTransaction({ amount: 42.5 }))
    expect(mapped.amount).toBe(-42.5)
  })

  it('negates a Plaid negative amount (inflow) to a core positive amount', () => {
    const mapped = mapTransaction(makePlaidTransaction({ amount: -100 }))
    expect(mapped.amount).toBe(100)
  })

  it('prefers authorized_date over date when present', () => {
    const mapped = mapTransaction(
      makePlaidTransaction({ date: '2026-01-10', authorized_date: '2026-01-08' })
    )
    expect(mapped.date).toBe('2026-01-08')
  })

  it('falls back to date when authorized_date is null', () => {
    const mapped = mapTransaction(makePlaidTransaction({ date: '2026-01-10', authorized_date: null }))
    expect(mapped.date).toBe('2026-01-10')
  })

  it('maps description from the Plaid name field', () => {
    const mapped = mapTransaction(makePlaidTransaction({ name: 'ACME CORP PURCHASE' }))
    expect(mapped.description).toBe('ACME CORP PURCHASE')
  })

  it('maps category to [primary, detailed] lowercased', () => {
    const mapped = mapTransaction(
      makePlaidTransaction({
        personal_finance_category: {
          primary: 'FOOD_AND_DRINK',
          detailed: 'FOOD_AND_DRINK_FAST_FOOD',
          confidence_level: 'HIGH',
        },
      })
    )
    expect(mapped.category).toEqual(['food_and_drink', 'food_and_drink_fast_food'])
  })

  it('leaves category undefined when Plaid does not return personal_finance_category', () => {
    const mapped = mapTransaction(makePlaidTransaction({ personal_finance_category: null }))
    expect(mapped.category).toBeUndefined()
  })

  it('maps merchant_name and pending through', () => {
    const mapped = mapTransaction(
      makePlaidTransaction({ merchant_name: 'Big Box Store', pending: true })
    )
    expect(mapped.merchant_name).toBe('Big Box Store')
    expect(mapped.pending).toBe(true)
  })

  it('maps id from transaction_id and account_id through', () => {
    const mapped = mapTransaction(
      makePlaidTransaction({ transaction_id: 'txn_abc', account_id: 'acc_xyz' })
    )
    expect(mapped.id).toBe('txn_abc')
    expect(mapped.account_id).toBe('acc_xyz')
  })
})

function makeStream(overrides: Partial<TransactionStream> = {}): TransactionStream {
  return {
    account_id: 'plaid_acc_checking',
    stream_id: 'stream_1',
    category: null,
    category_id: null,
    description: 'NETFLIX.COM',
    merchant_name: 'Netflix',
    first_date: '2026-01-01',
    last_date: '2026-03-01',
    predicted_next_date: '2026-04-01',
    frequency: 'MONTHLY' as TransactionStream['frequency'],
    transaction_ids: ['t1', 't2', 't3'],
    average_amount: { amount: 15.99, iso_currency_code: 'USD' },
    last_amount: { amount: 15.99, iso_currency_code: 'USD' },
    is_active: true,
    status: 'MATURE' as TransactionStream['status'],
    personal_finance_category: null,
    is_user_modified: false,
    ...overrides,
  } as TransactionStream
}

describe('mapRecurringCharge', () => {
  it('maps amount from average_amount without negation (core recurring amounts are positive)', () => {
    const mapped = mapRecurringCharge(makeStream({ average_amount: { amount: 89.99, iso_currency_code: 'USD' } }))
    expect(mapped?.amount).toBe(89.99)
  })

  it('maps next_date from predicted_next_date', () => {
    const mapped = mapRecurringCharge(makeStream({ predicted_next_date: '2026-05-01' }))
    expect(mapped?.next_date).toBe('2026-05-01')
  })

  it('falls back to last_date when predicted_next_date is missing', () => {
    const mapped = mapRecurringCharge(makeStream({ predicted_next_date: null, last_date: '2026-03-15' }))
    expect(mapped?.next_date).toBe('2026-03-15')
  })

  it.each([
    ['WEEKLY', 'weekly'],
    ['BIWEEKLY', 'biweekly'],
    ['SEMI_MONTHLY', 'biweekly'],
    ['MONTHLY', 'monthly'],
    ['ANNUALLY', 'annually'],
  ] as const)('maps frequency %s to %s', (plaidFrequency, coreFrequency) => {
    const mapped = mapRecurringCharge(
      makeStream({ frequency: plaidFrequency as TransactionStream['frequency'] })
    )
    expect(mapped?.frequency).toBe(coreFrequency)
  })

  it('drops streams with an UNKNOWN frequency (unmappable)', () => {
    const mapped = mapRecurringCharge(
      makeStream({ frequency: 'UNKNOWN' as TransactionStream['frequency'] })
    )
    expect(mapped).toBeUndefined()
  })

  it('maps confidence high for a mature, active stream', () => {
    const mapped = mapRecurringCharge(makeStream({ status: 'MATURE' as TransactionStream['status'], is_active: true }))
    expect(mapped?.confidence).toBe('high')
  })

  it('maps confidence medium for an early-detection, active stream', () => {
    const mapped = mapRecurringCharge(
      makeStream({ status: 'EARLY_DETECTION' as TransactionStream['status'], is_active: true })
    )
    expect(mapped?.confidence).toBe('medium')
  })

  it('maps confidence low for a tombstoned stream', () => {
    const mapped = mapRecurringCharge(
      makeStream({ status: 'TOMBSTONED' as TransactionStream['status'], is_active: false })
    )
    expect(mapped?.confidence).toBe('low')
  })

  it('maps confidence low for an inactive stream regardless of status', () => {
    const mapped = mapRecurringCharge(
      makeStream({ status: 'MATURE' as TransactionStream['status'], is_active: false })
    )
    expect(mapped?.confidence).toBe('low')
  })

  it('sets source to provider', () => {
    const mapped = mapRecurringCharge(makeStream())
    expect(mapped?.source).toBe('provider')
  })

  it('prefers merchant_name for description, falling back to description', () => {
    expect(mapRecurringCharge(makeStream({ merchant_name: 'Spotify' }))?.description).toBe('Spotify')
    expect(mapRecurringCharge(makeStream({ merchant_name: null, description: 'SPOTIFY USA' }))?.description).toBe(
      'SPOTIFY USA'
    )
  })
})
