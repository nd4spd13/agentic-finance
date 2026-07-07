/**
 * Helpers for reading Plaid's structured error payload off a rejected
 * promise from a `PlaidClientLike` method. The real Plaid SDK rejects with
 * an Axios error whose `response.data` is a `PlaidError`
 * (`{ error_type, error_code, error_message, ... }`); fakes used in tests
 * reject with plain objects shaped the same way.
 *
 * These helpers never format the raw error into a message (that risks
 * embedding request/response bodies that could carry secrets) — callers
 * that need to surface a message use a fixed, static string instead. See
 * WP1's `redactSecrets` / WP3/WP6's redaction discipline for the broader
 * policy this follows.
 */

interface PlaidErrorLike {
  error_code?: unknown
  error_type?: unknown
}

function extractPlaidErrorPayload(error: unknown): PlaidErrorLike | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  const withResponse = error as { response?: { data?: unknown } }
  const data = withResponse.response?.data
  if (typeof data === 'object' && data !== null) {
    return data as PlaidErrorLike
  }
  // Some fakes/tests may throw the Plaid error payload directly.
  if ('error_code' in error || 'error_type' in error) {
    return error as PlaidErrorLike
  }
  return undefined
}

/** Returns the Plaid `error_code` from a thrown/rejected error, if present. */
export function getPlaidErrorCode(error: unknown): string | undefined {
  const payload = extractPlaidErrorPayload(error)
  return typeof payload?.error_code === 'string' ? payload.error_code : undefined
}

export function isItemLoginRequired(error: unknown): boolean {
  return getPlaidErrorCode(error) === 'ITEM_LOGIN_REQUIRED'
}

export function isTransactionsSyncMutationDuringPagination(error: unknown): boolean {
  return getPlaidErrorCode(error) === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'
}
