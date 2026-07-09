export interface FinancialDataProvider {
  getAccounts(userId: string): Promise<Account[]>
  getTransactions(userId: string, accountId: string, opts?: TransactionQueryOpts): Promise<Transaction[]>
  getBalance(userId: string, accountId: string): Promise<Balance>
  getRecurringCharges?(userId: string, accountId: string): Promise<RecurringCharge[]>
}

/** @deprecated use FinancialDataProvider */
export type DataProvider = FinancialDataProvider

export interface Account {
  id: string
  name: string
  type: 'checking' | 'savings' | 'credit' | 'loan' | 'investment'
  subtype?: string
  /**
   * The human-readable name of the financial institution this account is
   * held at (e.g. "Chase", "Bank A Financial"), when a provider can resolve
   * one. Added in SF5 for the SimpleFIN adapter: a single SimpleFIN item can
   * span multiple institutions (one access URL, several `connections[]`
   * entries), so institution identity has to live per-account rather than
   * per-item the way Plaid's does. Deliberately distinct from `subtype`
   * (a refinement of `type`, e.g. Plaid's "money market"/"hsa") — the two
   * are different concepts and must not be conflated. Plaid leaves this
   * unset: for Plaid, one item is always exactly one institution, and that
   * name is already available per-item via `TokenStore`'s
   * `StoredItemMeta.institutionName` and at connect time via
   * `LinkFlowResult.institutionName`, so populating it again per-account
   * would be redundant.
   */
  institution?: string
  mask?: string
  balance_current: number
  balance_available?: number
  currency: string
  stale?: boolean
}

export interface Transaction {
  id: string
  account_id: string
  amount: number
  date: string
  description: string
  merchant_name?: string
  category?: string[]
  pending: boolean
  stale?: boolean
}

export interface Balance {
  account_id: string
  current: number
  available?: number
  currency: string
  last_updated: string
  stale?: boolean
}

export interface TransactionQueryOpts {
  start_date?: string
  end_date?: string
  count?: number
}

export interface RecurringCharge {
  description: string
  amount: number
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'annually'
  next_date: string
  confidence: 'high' | 'medium' | 'low'
  source: 'provider' | 'pattern_match' | 'manual'
}
