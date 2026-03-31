export interface DataProvider {
  getAccounts(userId: string): Promise<Account[]>
  getTransactions(userId: string, accountId: string, opts?: TransactionQueryOpts): Promise<Transaction[]>
  getBalance(userId: string, accountId: string): Promise<Balance>
  getRecurringCharges?(userId: string, accountId: string): Promise<RecurringCharge[]>
}

export interface Account {
  id: string
  name: string
  type: 'checking' | 'savings' | 'credit' | 'loan' | 'investment'
  subtype?: string
  mask?: string
  balance_current: number
  balance_available?: number
  currency: string
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
}

export interface Balance {
  account_id: string
  current: number
  available?: number
  currency: string
  last_updated: string
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
