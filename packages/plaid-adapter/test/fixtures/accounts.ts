import type { AccountBase } from 'plaid'

/** Canned `/accounts/get` (and `/accounts/balance/get`) fixtures. */

export const checkingAccount: AccountBase = {
  account_id: 'plaid_acc_checking',
  balances: {
    available: 950.25,
    current: 1000.5,
    limit: null,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
  },
  mask: '1111',
  name: 'Plaid Checking',
  official_name: 'Plaid Gold Standard 0% Interest Checking',
  type: 'depository' as AccountBase['type'],
  subtype: 'checking' as AccountBase['subtype'],
} as AccountBase

export const savingsAccount: AccountBase = {
  account_id: 'plaid_acc_savings',
  balances: {
    available: 5000,
    current: 5000,
    limit: null,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
  },
  mask: '2222',
  name: 'Plaid Savings',
  official_name: 'Plaid Silver Standard 0.1% Interest Saving',
  type: 'depository' as AccountBase['type'],
  subtype: 'savings' as AccountBase['subtype'],
} as AccountBase

export const creditAccount: AccountBase = {
  account_id: 'plaid_acc_credit',
  balances: {
    available: 8000,
    current: -410.75,
    limit: 10000,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
  },
  mask: '3333',
  name: 'Plaid Credit Card',
  official_name: 'Plaid Diamond 12.5% APR Interest Credit Card',
  type: 'credit' as AccountBase['type'],
  subtype: 'credit card' as AccountBase['subtype'],
} as AccountBase

export const loanAccount: AccountBase = {
  account_id: 'plaid_acc_loan',
  balances: {
    available: null,
    current: 12345.67,
    limit: null,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
  },
  mask: '4444',
  name: 'Plaid Student Loan',
  official_name: 'Plaid Student Loan',
  type: 'loan' as AccountBase['type'],
  subtype: 'student' as AccountBase['subtype'],
} as AccountBase

export const investmentAccount: AccountBase = {
  account_id: 'plaid_acc_investment',
  balances: {
    available: null,
    current: 25000,
    limit: null,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
  },
  mask: '5555',
  name: 'Plaid Brokerage',
  official_name: 'Plaid Brokerage Account',
  type: 'brokerage' as AccountBase['type'],
  subtype: 'brokerage' as AccountBase['subtype'],
} as AccountBase

export const unknownTypeAccount: AccountBase = {
  account_id: 'plaid_acc_unknown',
  balances: {
    available: null,
    current: 100,
    limit: null,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
  },
  mask: '6666',
  name: 'Plaid Mystery Account',
  official_name: null,
  type: 'other' as AccountBase['type'],
  subtype: 'other' as AccountBase['subtype'],
} as AccountBase
