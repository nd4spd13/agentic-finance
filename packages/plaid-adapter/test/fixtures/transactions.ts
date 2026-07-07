import type { Transaction as PlaidTransaction } from 'plaid'

/** Builds a canned Plaid `Transaction` with sensible defaults, override as needed. */
export function makePlaidTransaction(overrides: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    account_id: 'plaid_acc_checking',
    amount: 12.5,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    category: null,
    category_id: null,
    check_number: null,
    date: '2026-01-05',
    location: {
      address: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      lat: null,
      lon: null,
      store_number: null,
    },
    name: 'COFFEE SHOP 123',
    merchant_name: 'Coffee Shop',
    payment_meta: {
      by_order_of: null,
      payee: null,
      payer: null,
      payment_method: null,
      payment_processor: null,
      ppd_id: null,
      reason: null,
      reference_number: null,
    },
    pending: false,
    pending_transaction_id: null,
    account_owner: null,
    transaction_id: 'plaid_txn_default',
    logo_url: null,
    website: null,
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    payment_channel: 'in store' as PlaidTransaction['payment_channel'],
    personal_finance_category: {
      primary: 'FOOD_AND_DRINK',
      detailed: 'FOOD_AND_DRINK_COFFEE',
      confidence_level: 'HIGH',
    },
    transaction_code: null,
    ...overrides,
  } as PlaidTransaction
}
