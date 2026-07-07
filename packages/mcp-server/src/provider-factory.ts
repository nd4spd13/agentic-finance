import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DummyDataProvider, type FinancialDataProvider } from '@clad/core'

/**
 * Selects and constructs the `FinancialDataProvider` implementation for this
 * server process, based on `CLAD_PROVIDER` (default `'dummy'`).
 *
 * Factored out of `server.ts` so it's unit-testable without booting the full
 * MCP stdio server. The `'plaid'` branch dynamic-imports `@clad/plaid-adapter`
 * so the Plaid SDK is only loaded into memory when actually selected.
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
  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  const env = process.env.PLAID_ENV
  const passphrase = process.env.CLAD_TOKEN_PASSPHRASE

  const missing: string[] = []
  if (!clientId) missing.push('PLAID_CLIENT_ID')
  if (!secret) missing.push('PLAID_SECRET')
  if (!env) missing.push('PLAID_ENV')
  if (!passphrase) missing.push('CLAD_TOKEN_PASSPHRASE')

  if (!clientId || !secret || !env || !passphrase) {
    throw new Error(
      `[clad server] CLAD_PROVIDER=plaid requires the following environment ` +
        `variable(s), which are not set: ${missing.join(', ')}.`
    )
  }

  // `clad serve` forwards the config's `plaid_db` as CLAD_PLAID_DB; when the
  // server is invoked directly, fall back to the same default the CLI uses.
  const dbPath = process.env.CLAD_PLAID_DB ?? join(homedir(), '.clad', 'plaid.sqlite')
  mkdirSync(dirname(dbPath), { recursive: true })

  // Dynamic import: the Plaid SDK is only loaded into memory when the
  // 'plaid' provider is actually selected.
  const { PlaidAdapter, SqliteTokenStore, createPlaidClient } = await import(
    '@clad/plaid-adapter'
  )

  const client = createPlaidClient({ clientId, secret, env })
  // Throws TokenStoreKeyError (already redacted) on a wrong passphrase —
  // propagate so the server fails fast instead of serving with a broken store.
  const tokenStore = new SqliteTokenStore({ dbPath, passphrase })

  return new PlaidAdapter({ client, tokenStore, dbPath })
}
