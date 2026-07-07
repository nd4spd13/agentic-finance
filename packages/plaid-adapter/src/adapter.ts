import type {
  Account,
  Balance,
  FinancialDataProvider,
  RecurringCharge,
  Transaction,
  TransactionQueryOpts,
} from '@clad/core'
import type { PlaidClientLike } from './plaid-client.types.js'
import type { TokenStore } from './token-store.types.js'

export interface PlaidAdapterOptions {
  client: PlaidClientLike
  tokenStore: TokenStore
  dbPath: string
  userId?: string
}

/**
 * `FinancialDataProvider` backed by the Plaid API.
 *
 * This is a skeleton (WP2): constructor injection is wired up per
 * architecture decision #10, but every method is a stub. Method bodies
 * (sync-then-read, cache, mapping, degradation) land in WP5; the encrypted
 * `TokenStore` implementation lands in WP3; the Link connect flow lands in
 * WP4.
 */
export class PlaidAdapter implements FinancialDataProvider {
  private readonly client: PlaidClientLike
  private readonly tokenStore: TokenStore
  private readonly dbPath: string
  private readonly userId?: string

  constructor(options: PlaidAdapterOptions) {
    this.client = options.client
    this.tokenStore = options.tokenStore
    this.dbPath = options.dbPath
    this.userId = options.userId
  }

  async getAccounts(_userId: string): Promise<Account[]> {
    throw new Error('NotImplemented: PlaidAdapter.getAccounts')
  }

  async getTransactions(
    _userId: string,
    _accountId: string,
    _opts?: TransactionQueryOpts
  ): Promise<Transaction[]> {
    throw new Error('NotImplemented: PlaidAdapter.getTransactions')
  }

  async getBalance(_userId: string, _accountId: string): Promise<Balance> {
    throw new Error('NotImplemented: PlaidAdapter.getBalance')
  }

  async getRecurringCharges(_userId: string, _accountId: string): Promise<RecurringCharge[]> {
    throw new Error('NotImplemented: PlaidAdapter.getRecurringCharges')
  }
}
