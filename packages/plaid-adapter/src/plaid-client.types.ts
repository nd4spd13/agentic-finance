import type {
  AccountsBalanceGetRequest,
  AccountsGetRequest,
  AccountsGetResponse,
  ItemPublicTokenExchangeRequest,
  ItemPublicTokenExchangeResponse,
  LinkTokenCreateRequest,
  LinkTokenCreateResponse,
  SandboxPublicTokenCreateRequest,
  SandboxPublicTokenCreateResponse,
  TransactionsRecurringGetRequest,
  TransactionsRecurringGetResponse,
  TransactionsSyncRequest,
  TransactionsSyncResponse,
} from 'plaid'
import type { AxiosResponse } from 'axios'

/**
 * The minimal subset of the Plaid SDK's `PlaidApi` surface used by
 * `PlaidAdapter`. Keeping this narrow (rather than depending on the full
 * `PlaidApi` class) lets unit tests substitute a fake client that never
 * touches the network — see architecture decision #10 in the CRS-25 plan.
 *
 * Method shapes mirror `PlaidApi` exactly (request DTO in, `AxiosResponse`
 * of the response DTO out) so a real `PlaidApi` instance satisfies this
 * interface with no adaptation needed.
 */
export interface PlaidClientLike {
  linkTokenCreate(
    request: LinkTokenCreateRequest
  ): Promise<AxiosResponse<LinkTokenCreateResponse>>

  itemPublicTokenExchange(
    request: ItemPublicTokenExchangeRequest
  ): Promise<AxiosResponse<ItemPublicTokenExchangeResponse>>

  accountsGet(request: AccountsGetRequest): Promise<AxiosResponse<AccountsGetResponse>>

  accountsBalanceGet(
    request: AccountsBalanceGetRequest
  ): Promise<AxiosResponse<AccountsGetResponse>>

  transactionsSync(
    request: TransactionsSyncRequest
  ): Promise<AxiosResponse<TransactionsSyncResponse>>

  transactionsRecurringGet(
    request: TransactionsRecurringGetRequest
  ): Promise<AxiosResponse<TransactionsRecurringGetResponse>>

  sandboxPublicTokenCreate(
    request: SandboxPublicTokenCreateRequest
  ): Promise<AxiosResponse<SandboxPublicTokenCreateResponse>>
}
