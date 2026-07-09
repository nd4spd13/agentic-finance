export { decodeSetupToken, claimSetupToken } from './claim.js'
export type { ClaimSetupTokenOptions, FetchLike } from './claim.js'
export { SimpleFinError, SimpleFinTokenError, SimpleFinClaimError } from './errors.js'
export type { SimpleFinErrorOptions } from './errors.js'
export {
  SimpleFinRequestError,
  SimpleFinNetworkError,
  SimpleFinResponseError,
  SimpleFinHttpError,
  SimpleFinSubscriptionError,
  SimpleFinAccessTokenError,
  SimpleFinProtocolError,
  SimpleFinGeneralError,
  SimpleFinConnectionError,
  SimpleFinAccountError,
} from './errors.js'
// SF6 fix: `MAX_WINDOW_SECONDS` was exported from `client.ts` (for `adapter.ts`,
// same package, importing it directly) but never re-exported from this
// public entry point. `packages/cli/src/commands/connect.ts` needs the same
// "widest protocol-allowed window" constant `adapter.ts`'s `refreshItemIfDue`
// uses, to keep its own initial post-connect fetch consistent instead of
// duplicating the `90 * 24 * 60 * 60` literal — an external-consumer gap SF5
// missed since no package outside this one needed it until SF6.
export {
  fetchAccounts,
  buildAccountsRequest,
  parseAccountSet,
  parseProtocolError,
  MAX_WINDOW_SECONDS,
} from './client.js'
export type {
  FetchAccountsOptions,
  SimpleFinAccountSet,
  SimpleFinAccount,
  SimpleFinTransaction,
  SimpleFinHolding,
  SimpleFinConnection,
} from './client.js'
export {
  epochSecondsToDateString,
  mapAccount,
  mapAccountId,
  mapAccountSet,
  mapAccountType,
  mapTransaction,
  mapTransactionId,
  parseSimpleFinAmount,
  resolveConnection,
  SimpleFinMappingError,
} from './mapping.js'
// Note: SF3's client.ts wire types (SimpleFinAccount, SimpleFinTransaction,
// SimpleFinHolding, SimpleFinConnection, SimpleFinAccountSet, exported
// above) are canonical and cover the DTOs mapping.ts consumes — SF4 used to
// declare a parallel, duplicate set of `*Dto` types here; SF5 unified them
// (see mapping.ts's header comment), so there is nothing further to export
// from mapping.ts's DTO surface.
export { SimpleFinCache } from './cache.js'
export type {
  CachedAccount,
  CachedTransaction,
  SimpleFinCacheOptions,
  StalenessInfo,
} from './cache.js'
export { SimpleFinAdapter } from './adapter.js'
export type { SimpleFinAdapterOptions } from './adapter.js'
