/**
 * Thrown when a data provider (e.g. the Plaid adapter) cannot reach its
 * upstream API and has no local cache to fall back on.
 */
export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'ProviderUnavailableError'
    Object.setPrototypeOf(this, ProviderUnavailableError.prototype)
  }
}

/**
 * Thrown when a provider item requires re-authentication (e.g. Plaid's
 * `ITEM_LOGIN_REQUIRED`) or its token has been revoked. Carries the
 * `item_id` for the affected connection so callers can prompt reconnection —
 * it never carries the access token itself.
 */
export class ProviderAuthError extends Error {
  readonly code = 'PROVIDER_AUTH_ERROR'
  readonly item_id: string

  constructor(message: string, item_id: string) {
    super(message)
    this.name = 'ProviderAuthError'
    this.item_id = item_id
    Object.setPrototypeOf(this, ProviderAuthError.prototype)
  }
}
