import { DummyDataProvider, type FinancialDataProvider } from '@clad/core'

/**
 * Selects and constructs the `FinancialDataProvider` implementation for this
 * server process, based on `CLAD_PROVIDER` (default `'dummy'`).
 *
 * Factored out of `server.ts` so it's unit-testable without booting the full
 * MCP stdio server. The `'plaid'` branch dynamic-imports `@clad/plaid-adapter`
 * so the Plaid SDK is only loaded into memory when actually selected.
 *
 * NOTE: the encrypted `TokenStore` implementation lands in WP3 and the Plaid
 * Link connect flow lands in WP4. Until then, selecting `provider: 'plaid'`
 * fails fast with a clear "not yet implemented" error — this branch exists
 * so config/env plumbing can be built and tested ahead of those work
 * packages, and is intentionally minimal/temporary.
 */
export async function createProvider(): Promise<FinancialDataProvider> {
  const provider = process.env.CLAD_PROVIDER ?? 'dummy'

  if (provider === 'dummy') {
    return new DummyDataProvider()
  }

  if (provider === 'plaid') {
    return createPlaidProvider()
  }

  throw new Error(
    `[clad server] Unknown CLAD_PROVIDER "${provider}". Expected "dummy" or "plaid".`
  )
}

async function createPlaidProvider(): Promise<FinancialDataProvider> {
  const missing: string[] = []
  if (!process.env.PLAID_CLIENT_ID) missing.push('PLAID_CLIENT_ID')
  if (!process.env.PLAID_SECRET) missing.push('PLAID_SECRET')
  if (!process.env.CLAD_TOKEN_PASSPHRASE) missing.push('CLAD_TOKEN_PASSPHRASE')

  if (missing.length > 0) {
    throw new Error(
      `[clad server] CLAD_PROVIDER=plaid requires the following environment ` +
        `variable(s), which are not set: ${missing.join(', ')}.`
    )
  }

  // Dynamic import: the Plaid SDK is only loaded into memory when the
  // 'plaid' provider is actually selected.
  await import('@clad/plaid-adapter')

  // WP3 (encrypted TokenStore) and WP4 (Link connect flow) are not
  // implemented yet, so there is no way to construct a working PlaidAdapter
  // (client + tokenStore) in this work package. This branch is intentionally
  // minimal and temporary — it exists to validate config/env plumbing ahead
  // of those work packages.
  throw new Error(
    '[clad server] CLAD_PROVIDER=plaid is not yet implemented: the encrypted ' +
      'token store (CRS-25 WP3) and Plaid Link connect flow (CRS-25 WP4) have ' +
      'not landed yet. Use CLAD_PROVIDER=dummy (or unset it) until then.'
  )
}
