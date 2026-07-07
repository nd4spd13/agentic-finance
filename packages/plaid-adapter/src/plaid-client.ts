import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'
import type { PlaidClientLike } from './plaid-client.types.js'

export interface CreatePlaidClientOptions {
  clientId: string
  secret: string
  /** Plaid environment name, e.g. 'sandbox' or 'production' (`PLAID_ENV`). */
  env: string
}

/**
 * Constructs a real Plaid SDK client satisfying `PlaidClientLike`.
 *
 * Kept here (rather than in each consumer) so the mcp-server provider
 * factory and the CLI both build the client the same way, and so the
 * `plaid` package stays a dependency of this adapter only.
 */
export function createPlaidClient(options: CreatePlaidClientOptions): PlaidClientLike {
  const basePath = PlaidEnvironments[options.env]
  if (!basePath) {
    throw new Error(
      `Unsupported PLAID_ENV "${options.env}". Expected one of: ` +
        `${Object.keys(PlaidEnvironments).join(', ')}.`
    )
  }

  return new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': options.clientId,
          'PLAID-SECRET': options.secret,
        },
      },
    })
  )
}
