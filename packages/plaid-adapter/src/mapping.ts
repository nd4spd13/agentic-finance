import type { Account, RecurringCharge, Transaction } from '@clad/core'
import type {
  AccountBase,
  RemovedTransaction,
  Transaction as PlaidTransaction,
  TransactionStream,
} from 'plaid'

/**
 * Pure mapping helpers translating Plaid API DTOs to `@clad/core` types.
 * Kept separate from `adapter.ts` so each mapping rule can be unit tested
 * in isolation (see `test/mapping.test.ts`).
 */

/**
 * Maps a Plaid `AccountBase` to the core `Account` union type.
 *
 * Mapping rules (per CRS-25 WP5 spec):
 *  - depository/checking -> checking
 *  - depository/savings  -> savings
 *  - credit              -> credit
 *  - loan                -> loan
 *  - investment/brokerage -> investment
 *  - anything else: nearest core type, with the original Plaid `subtype`
 *    preserved on `subtype` so no information is lost.
 */
export function mapAccountType(
  type: AccountBase['type'],
  subtype: AccountBase['subtype']
): Account['type'] {
  if (type === 'depository') {
    return subtype === 'savings' ? 'savings' : 'checking'
  }
  if (type === 'credit') {
    return 'credit'
  }
  if (type === 'loan') {
    return 'loan'
  }
  if (type === 'investment' || type === 'brokerage') {
    return 'investment'
  }
  // 'other' or any future Plaid type: nearest fallback is checking, with
  // the original subtype preserved for callers that want more detail.
  return 'checking'
}

export function mapAccount(account: AccountBase): Account {
  return {
    id: account.account_id,
    name: account.name,
    type: mapAccountType(account.type, account.subtype),
    subtype: account.subtype ?? undefined,
    mask: account.mask ?? undefined,
    balance_current: account.balances.current ?? 0,
    balance_available: account.balances.available ?? undefined,
    currency: account.balances.iso_currency_code ?? account.balances.unofficial_currency_code ?? 'USD',
  }
}

/**
 * Maps a Plaid `Transaction` to the core `Transaction` type.
 *
 * Mapping rules (per CRS-25 WP5 spec, critical for correctness):
 *  - amount: `-plaid.amount` — Plaid uses positive = money out, negative =
 *    money in; `@clad/core` uses the opposite convention (negative = money
 *    out). Negating here is what makes the two conventions agree.
 *  - date: `authorized_date ?? date` — prefer the day the transaction was
 *    actually authorized over the (possibly later) posted date.
 *  - description: `name` (Plaid's legacy free-text description field).
 *  - category: `personal_finance_category` primary + detailed, lowercased,
 *    as a two-element array; undefined if Plaid didn't return a category.
 */
export function mapTransaction(transaction: PlaidTransaction): Transaction {
  const category = transaction.personal_finance_category
    ? [
        transaction.personal_finance_category.primary.toLowerCase(),
        transaction.personal_finance_category.detailed.toLowerCase(),
      ]
    : undefined

  return {
    id: transaction.transaction_id,
    account_id: transaction.account_id,
    amount: -transaction.amount,
    date: transaction.authorized_date ?? transaction.date,
    description: transaction.name,
    merchant_name: transaction.merchant_name ?? undefined,
    category,
    pending: transaction.pending,
  }
}

export function mapRemovedTransactionId(removed: RemovedTransaction): string {
  return removed.transaction_id
}

const FREQUENCY_MAP: Record<string, RecurringCharge['frequency'] | undefined> = {
  WEEKLY: 'weekly',
  BIWEEKLY: 'biweekly',
  SEMI_MONTHLY: 'biweekly', // closest core frequency to Plaid's twice-a-month cadence
  MONTHLY: 'monthly',
  ANNUALLY: 'annually',
}

/**
 * Maps a Plaid outflow `TransactionStream` (from `/transactions/recurring/get`)
 * to a core `RecurringCharge`, or `undefined` if the stream's frequency has
 * no reasonable mapping (Plaid's `UNKNOWN` frequency).
 *
 * Mapping rules:
 *  - amount: `average_amount` (Plaid outflow streams report positive
 *    amounts for money leaving the account, matching the core convention
 *    used by `DummyDataProvider`'s recurring charges — no negation here).
 *  - next_date: `predicted_next_date` (falls back to `last_date` if Plaid
 *    could not predict a next occurrence).
 *  - frequency: WEEKLY->weekly, BIWEEKLY->biweekly, SEMI_MONTHLY->biweekly,
 *    MONTHLY->monthly, ANNUALLY->annually; UNKNOWN is unmappable (dropped).
 *  - confidence: derived from Plaid's `status` + `is_active` since Plaid
 *    has no direct analog to `high`/`medium`/`low` confidence:
 *      - status MATURE && is_active        -> 'high'   (established, live pattern)
 *      - status EARLY_DETECTION && is_active -> 'medium' (too new to be certain)
 *      - status TOMBSTONED || !is_active   -> 'low'    (stream has gone quiet)
 *      - status UNKNOWN                    -> 'low'    (no signal either way)
 *  - source: always `'provider'` — this came directly from Plaid's own
 *    recurring-transaction detection, not local pattern matching.
 */
export function mapRecurringCharge(stream: TransactionStream): RecurringCharge | undefined {
  const frequency = FREQUENCY_MAP[stream.frequency]
  if (!frequency) {
    return undefined
  }

  return {
    description: stream.merchant_name ?? stream.description,
    amount: stream.average_amount.amount ?? 0,
    frequency,
    next_date: stream.predicted_next_date ?? stream.last_date,
    confidence: mapRecurringConfidence(stream),
    source: 'provider',
  }
}

function mapRecurringConfidence(stream: TransactionStream): RecurringCharge['confidence'] {
  if (!stream.is_active) {
    return 'low'
  }
  switch (stream.status) {
    case 'MATURE':
      return 'high'
    case 'EARLY_DETECTION':
      return 'medium'
    case 'TOMBSTONED':
      return 'low'
    default:
      return 'low'
  }
}
