import {
  ProviderAuthError,
  ProviderUnavailableError,
  redactSecrets,
  type Account,
  type Balance,
  type FinancialDataProvider,
  type RecurringCharge,
  type StoredItemMeta,
  type Transaction,
  type TokenStore,
  type TransactionQueryOpts,
} from '@clad/core'
import { PlaidCache } from './cache.js'
import { mapAccount, mapRecurringCharge, mapTransaction } from './mapping.js'
import { getPlaidErrorCode, isItemLoginRequired, isTransactionsSyncMutationDuringPagination } from './plaid-error.js'
import type { PlaidClientLike } from './plaid-client.types.js'

export interface PlaidAdapterOptions {
  client: PlaidClientLike
  tokenStore: TokenStore
  dbPath: string
  /**
   * Passphrase that unlocks the encrypted cache (D5.1). The same passphrase
   * already guards the `tokenStore`'s DB file — the cache shares that file, so
   * the same key derives from the same salt (see `PlaidCache`/`openDatabaseKey`).
   */
  passphrase: string
  userId?: string
}

/**
 * `FinancialDataProvider` backed by the Plaid API.
 *
 * Implements the "sync-then-read" pattern (architecture decision #7):
 * `getTransactions` refreshes the local SQLite cache via
 * `/transactions/sync` cursor pagination, then answers queries from the
 * cache. `getAccounts`/`getBalance` call Plaid directly and upsert the
 * cache; on failure they degrade to serving cached data with
 * `stale: true`, or throw `ProviderUnavailableError` if there is no cache.
 *
 * Aggregates across every item in the injected `TokenStore` — an
 * `accountId` argument is routed to its owning item via the accounts
 * cache (falling back to scanning all items if the account isn't cached
 * yet, e.g. on a cold cache after a failed initial sync).
 *
 * Populates `Account.institution` from the owning item's
 * `StoredItemMeta.institutionName` on every account this adapter returns
 * (D3 QA amendment, 2026-07-10 — the Dashboard aggregates accounts across
 * multiple items with no other way to tell them apart). This is a
 * deliberate departure from `@clad/core`'s `Account.institution` doc
 * comment, which called per-account institution "redundant" for Plaid
 * since one item is always exactly one institution — that reasoning holds
 * for a single-item view, but not once accounts from many items are
 * flattened into one list for display, which is exactly what the
 * Dashboard does.
 */
export class PlaidAdapter implements FinancialDataProvider {
  private readonly client: PlaidClientLike
  private readonly tokenStore: TokenStore
  private readonly dbPath: string
  private readonly userId?: string
  private readonly cache: PlaidCache

  constructor(options: PlaidAdapterOptions) {
    this.client = options.client
    this.tokenStore = options.tokenStore
    this.dbPath = options.dbPath
    this.userId = options.userId
    this.cache = new PlaidCache({ dbPath: this.dbPath, passphrase: options.passphrase })
  }

  async getAccounts(_userId: string): Promise<Account[]> {
    const items = this.tokenStore.listItems()

    try {
      const accounts: Account[] = []
      for (const item of items) {
        const mapped = await this.fetchAccountsForItem(item)
        accounts.push(...mapped)
      }
      return accounts
    } catch (error) {
      return this.degradeToAccountsCache(error)
    }
  }

  async getBalance(_userId: string, accountId: string): Promise<Balance> {
    const itemId = this.resolveItemIdForAccount(accountId)

    try {
      if (!itemId) {
        throw new ProviderUnavailableError(
          `No Plaid item is associated with account ${accountId}`
        )
      }
      const accessToken = this.tokenStore.getAccessToken(itemId)
      const response = await this.client.accountsBalanceGet({ access_token: accessToken })
      const institution = this.resolveInstitutionNameForItem(itemId)
      const accounts = response.data.accounts
        .map(mapAccount)
        .map(account => ({ ...account, institution }))
      this.cache.upsertAccounts(itemId, accounts)

      const account = accounts.find(a => a.id === accountId)
      if (!account) {
        throw new ProviderUnavailableError(`Account ${accountId} not found for its Plaid item`)
      }

      return {
        account_id: account.id,
        current: account.balance_current,
        available: account.balance_available,
        currency: account.currency,
        last_updated: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof ProviderAuthError) throw error
      return this.degradeToBalanceCache(accountId, error)
    }
  }

  async getTransactions(
    _userId: string,
    accountId: string,
    opts?: TransactionQueryOpts
  ): Promise<Transaction[]> {
    const items = this.tokenStore.listItems()
    let syncFailed = false
    let syncError: unknown

    for (const item of items) {
      try {
        await this.syncTransactionsForItem(item)
      } catch (error) {
        if (error instanceof ProviderAuthError) throw error
        syncFailed = true
        syncError = error
      }
    }

    const cached = this.cache.getTransactionsByAccount(accountId, opts)

    if (syncFailed && cached.length === 0) {
      throw new ProviderUnavailableError(
        `Unable to sync transactions from Plaid and no cached data is available: ${describeError(syncError)}`
      )
    }

    return cached.map(({ itemId: _itemId, ...transaction }) => ({
      ...transaction,
      ...(syncFailed ? { stale: true } : {}),
    }))
  }

  async getRecurringCharges(_userId: string, accountId: string): Promise<RecurringCharge[]> {
    const itemId = this.resolveItemIdForAccount(accountId)
    if (!itemId) {
      throw new ProviderUnavailableError(
        `No Plaid item is associated with account ${accountId}`
      )
    }

    try {
      const accessToken = this.tokenStore.getAccessToken(itemId)
      const response = await this.client.transactionsRecurringGet({
        access_token: accessToken,
        account_ids: [accountId],
      })

      const charges: RecurringCharge[] = []
      for (const stream of response.data.outflow_streams) {
        const mapped = mapRecurringCharge(stream)
        if (mapped) charges.push(mapped)
      }
      return charges
    } catch (error) {
      if (isItemLoginRequired(error)) {
        throw new ProviderAuthError(
          'Plaid item requires the user to re-authenticate',
          itemId
        )
      }
      throw new ProviderUnavailableError(
        `Unable to fetch recurring charges from Plaid: ${describeError(error)}`
      )
    }
  }

  // -----------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------

  /** Fetches and caches accounts for a single item, translating Plaid errors. */
  private async fetchAccountsForItem(item: StoredItemMeta): Promise<Account[]> {
    try {
      const accessToken = this.tokenStore.getAccessToken(item.itemId)
      const response = await this.client.accountsGet({ access_token: accessToken })
      const accounts = response.data.accounts
        .map(mapAccount)
        .map(account => ({ ...account, institution: item.institutionName }))
      this.cache.upsertAccounts(item.itemId, accounts)
      return accounts
    } catch (error) {
      if (isItemLoginRequired(error)) {
        throw new ProviderAuthError(
          'Plaid item requires the user to re-authenticate',
          item.itemId
        )
      }
      throw error
    }
  }

  /** Degrades `getAccounts` to the cache, marking every account stale. */
  private degradeToAccountsCache(error: unknown): Account[] {
    if (error instanceof ProviderAuthError) throw error

    const cached = this.cache.getAllAccounts()
    if (cached.length === 0) {
      throw new ProviderUnavailableError(
        `Unable to reach Plaid and no cached accounts are available: ${describeError(error)}`
      )
    }
    return cached.map(({ itemId: _itemId, ...account }) => ({ ...account, stale: true }))
  }

  /** Degrades `getBalance` to the cache for a single account. */
  private degradeToBalanceCache(accountId: string, error: unknown): Balance {
    const cached = this.cache.getAccount(accountId)
    if (!cached) {
      throw new ProviderUnavailableError(
        `Unable to reach Plaid and no cached balance is available for account ${accountId}: ${describeError(error)}`
      )
    }
    return {
      account_id: cached.id,
      current: cached.balance_current,
      available: cached.balance_available,
      currency: cached.currency,
      last_updated: new Date().toISOString(),
      stale: true,
    }
  }

  /**
   * Refreshes the transaction cache for one item via `/transactions/sync`,
   * looping while `has_more` and persisting added/modified/removed rows
   * plus the cursor after every page. If Plaid reports
   * `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, restarts the sync loop
   * from the last cursor that was actually saved (i.e. the start of this
   * call, or whatever page most recently completed).
   */
  private async syncTransactionsForItem(item: StoredItemMeta): Promise<void> {
    const accessToken = this.tokenStore.getAccessToken(item.itemId)
    // Captured once, before this call fetches any pages. On a
    // TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION error we always restart
    // from this fixed value rather than re-reading the cache, since pages
    // already completed *during this call* will have advanced the saved
    // cursor past where we started.
    const cursorAtCallStart = this.cache.getCursor(item.itemId)

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.runSyncLoop(item.itemId, accessToken, cursorAtCallStart)
        return
      } catch (error) {
        if (isItemLoginRequired(error)) {
          throw new ProviderAuthError(
            'Plaid item requires the user to re-authenticate',
            item.itemId
          )
        }
        if (isTransactionsSyncMutationDuringPagination(error)) {
          // Restart the whole sync loop from the last *saved* cursor.
          continue
        }
        throw error
      }
    }
  }

  /** Runs `/transactions/sync` pages starting from `cursor` until `has_more` is false. */
  private async runSyncLoop(
    itemId: string,
    accessToken: string,
    cursor: string | undefined
  ): Promise<void> {
    let nextCursor = cursor

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await this.client.transactionsSync({
        access_token: accessToken,
        cursor: nextCursor,
      })
      const { added, modified, removed, next_cursor, has_more } = response.data

      const upserts = [...added, ...modified].map(mapTransaction)
      this.cache.upsertTransactions(itemId, upserts)
      this.cache.removeTransactions(removed.map(r => r.transaction_id))
      this.cache.saveCursor(itemId, next_cursor)

      nextCursor = next_cursor
      if (!has_more) {
        return
      }
    }
  }

  /** Resolves the owning item for an account via the accounts cache. */
  private resolveItemIdForAccount(accountId: string): string | undefined {
    return this.cache.getItemIdForAccount(accountId)
  }

  /**
   * Looks up an item's institution name via the token store, or `undefined`
   * if the item is no longer stored (e.g. deleted between resolving
   * `itemId` and this call). Used by `getBalance`, which — unlike
   * `fetchAccountsForItem` — only has an `itemId`, not the full
   * `StoredItemMeta`.
   */
  private resolveInstitutionNameForItem(itemId: string): string | undefined {
    return this.tokenStore.listItems().find(i => i.itemId === itemId)?.institutionName
  }
}

/**
 * Produces a description of an unknown error safe to embed in a thrown
 * message. Prefers the structured Plaid `error_code` (never contains
 * secrets); falls back to the error's message run through `redactSecrets`
 * defensively, since Axios errors can embed request bodies/headers that
 * carry `PLAID_SECRET` or access tokens.
 */
function describeError(error: unknown): string {
  const code = getPlaidErrorCode(error)
  if (code) return code
  if (error instanceof Error) return redactSecrets(error.message)
  return 'unknown error'
}
