import type { AxiosResponse } from 'axios'
import type {
  AccountsBalanceGetResponse,
  AccountsGetResponse,
  TransactionsRecurringGetResponse,
  TransactionsSyncResponse,
} from 'plaid'
import type { PlaidClientLike } from '../../src/plaid-client.types.js'
import type { StoredItemInput, StoredItemMeta, TokenStore } from '../../src/token-store.types.js'

function toAxiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  }
}

/** A Plaid-shaped error, mirroring the payload real Axios errors carry in `response.data`. */
export function makePlaidError(error_code: string, error_message = 'plaid error'): Error & {
  response: { data: { error_type: string; error_code: string; error_message: string } }
} {
  const error = new Error(error_message) as Error & {
    response: { data: { error_type: string; error_code: string; error_message: string } }
  }
  error.response = {
    data: { error_type: 'ITEM_ERROR', error_code, error_message },
  }
  return error
}

export interface FakePlaidClientHandlers {
  accountsGet?: PlaidClientLike['accountsGet']
  accountsBalanceGet?: PlaidClientLike['accountsBalanceGet']
  transactionsSync?: PlaidClientLike['transactionsSync']
  transactionsRecurringGet?: PlaidClientLike['transactionsRecurringGet']
}

const notImplemented = async (): Promise<never> => {
  throw new Error('fake client method not implemented in this test')
}

/** Builds a `PlaidClientLike` fake from per-method handlers; unset methods reject. */
export function makeFakeClient(handlers: FakePlaidClientHandlers = {}): PlaidClientLike {
  return {
    linkTokenCreate: notImplemented,
    itemPublicTokenExchange: notImplemented,
    accountsGet: handlers.accountsGet ?? notImplemented,
    accountsBalanceGet: handlers.accountsBalanceGet ?? notImplemented,
    transactionsSync: handlers.transactionsSync ?? notImplemented,
    transactionsRecurringGet: handlers.transactionsRecurringGet ?? notImplemented,
    sandboxPublicTokenCreate: notImplemented,
  } as unknown as PlaidClientLike
}

/** Wraps a plain response value into the `AxiosResponse` shape `PlaidClientLike` expects. */
export function respond<T>(data: T): Promise<AxiosResponse<T>> {
  return Promise.resolve(toAxiosResponse(data))
}

export function accountsGetResponse(
  accounts: AccountsGetResponse['accounts']
): AccountsGetResponse {
  return {
    accounts,
    item: {
      item_id: 'unused',
      institution_id: null,
      webhook: null,
      auth_method: null,
      error: null,
      available_products: [],
      billed_products: [],
      products: [],
      consented_products: [],
      consented_use_cases: null,
      consented_data_scopes: null,
      consent_expiration_time: null,
      update_type: 'background',
    } as unknown as AccountsGetResponse['item'],
    request_id: 'req_1',
  }
}

export function balanceGetResponse(
  accounts: AccountsBalanceGetResponse['accounts']
): AccountsGetResponse {
  return accountsGetResponse(accounts)
}

export function syncResponse(
  overrides: Partial<TransactionsSyncResponse>
): TransactionsSyncResponse {
  return {
    transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' as TransactionsSyncResponse['transactions_update_status'],
    accounts: [],
    added: [],
    modified: [],
    removed: [],
    next_cursor: 'cursor_0',
    has_more: false,
    request_id: 'req_sync',
    ...overrides,
  }
}

export function recurringResponse(
  overrides: Partial<TransactionsRecurringGetResponse>
): TransactionsRecurringGetResponse {
  return {
    inflow_streams: [],
    outflow_streams: [],
    updated_datetime: '2026-01-01T00:00:00Z',
    request_id: 'req_recurring',
    ...overrides,
  }
}

/** In-memory `TokenStore` fake — mirrors WP2's scaffold fake, shared across WP5 tests. */
export function makeFakeTokenStore(): TokenStore {
  const items = new Map<string, StoredItemMeta & { accessToken: string }>()
  return {
    saveItem(item: StoredItemInput) {
      const now = new Date().toISOString()
      items.set(item.itemId, {
        itemId: item.itemId,
        institutionName: item.institutionName,
        accessToken: item.accessToken,
        createdAt: now,
        updatedAt: now,
      })
    },
    getAccessToken(itemId: string) {
      const found = items.get(itemId)
      if (!found) throw new Error('item not found')
      return found.accessToken
    },
    listItems() {
      return Array.from(items.values()).map(({ itemId, institutionName, createdAt, updatedAt }) => ({
        itemId,
        institutionName,
        createdAt,
        updatedAt,
      }))
    },
    deleteItem(itemId: string) {
      items.delete(itemId)
    },
    close() {
      /* no-op for fake */
    },
  }
}
