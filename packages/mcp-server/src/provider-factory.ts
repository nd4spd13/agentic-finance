import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DummyDataProvider, SqliteTokenStore, type FinancialDataProvider } from '@clad/core'

/**
 * Selects and constructs the `FinancialDataProvider` implementation for this
 * server process, based on `CLAD_PROVIDER` (default `'dummy'`).
 *
 * Factored out of `server.ts` so it's unit-testable without booting the full
 * MCP stdio server. The `'plaid'` and `'simplefin'` branches dynamic-import
 * their respective adapter packages so each provider's dependencies are only
 * loaded into memory when actually selected (the Plaid SDK for `'plaid'`;
 * `@clad/simplefin-adapter` has no comparable SDK today, but the same
 * dynamic-import shape is used for consistency and to keep this file's
 * "only pay for what you select" property true as that package grows).
 * `SqliteTokenStore` itself is imported statically from `@clad/core` (both
 * branches need it, and it carries no provider-specific SDK weight).
 */
export async function createProvider(): Promise<FinancialDataProvider> {
  const provider = process.env.CLAD_PROVIDER ?? 'dummy'

  if (provider === 'dummy') {
    return new DummyDataProvider()
  }

  if (provider === 'plaid') {
    return createPlaidProvider()
  }

  if (provider === 'simplefin') {
    return createSimpleFinProvider()
  }

  throw new Error(
    `[clad server] Unknown CLAD_PROVIDER "${provider}". Expected "dummy", "plaid", or "simplefin".`
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
  // 'plaid' provider is actually selected. (SqliteTokenStore comes from the
  // static @clad/core import at the top of this file — @clad/plaid-adapter
  // re-exports the same class, but there is no need to load it twice.)
  const { PlaidAdapter, createPlaidClient } = await import('@clad/plaid-adapter')

  const client = createPlaidClient({ clientId, secret, env })
  // Throws TokenStoreKeyError (already redacted) on a wrong passphrase —
  // propagate so the server fails fast instead of serving with a broken store.
  const tokenStore = new SqliteTokenStore({ dbPath, passphrase })

  return new PlaidAdapter({ client, tokenStore, dbPath, passphrase })
}

/**
 * Constructs the SimpleFIN provider. Mirrors `createPlaidProvider`'s shape,
 * but SimpleFIN needs only one credential: `CLAD_TOKEN_PASSPHRASE` to unlock
 * the (shared-shape, `@clad/core`) `SqliteTokenStore`. There is no
 * client-id/secret/environment triad to configure — SimpleFIN's whole
 * pitch is no developer account and no company-held credentials (roadmap
 * P2); the only "credential" is the per-item access URL a user obtains
 * themselves via `clad connect --provider simplefin` (SF6) and that this
 * factory never touches directly.
 */
async function createSimpleFinProvider(): Promise<FinancialDataProvider> {
  const passphrase = process.env.CLAD_TOKEN_PASSPHRASE

  // Only one credential is ever required here (unlike Plaid's client
  // id/secret/env triad), but the message still names it explicitly —
  // matching createPlaidProvider's "name what's missing" wording — rather
  // than a generic "a passphrase is required".
  if (!passphrase) {
    throw new Error(
      `[clad server] CLAD_PROVIDER=simplefin requires the following environment ` +
        `variable(s), which are not set: CLAD_TOKEN_PASSPHRASE.`
    )
  }

  // `clad serve` forwards the config's `simplefin_db` as CLAD_SIMPLEFIN_DB;
  // when the server is invoked directly, fall back to a sibling default of
  // the Plaid store's (kept separate from plaid.sqlite: distinct providers,
  // distinct items, no reason to share one file).
  const dbPath = process.env.CLAD_SIMPLEFIN_DB ?? join(homedir(), '.clad', 'simplefin.sqlite')
  mkdirSync(dirname(dbPath), { recursive: true })

  // Dynamic import, mirroring the 'plaid' branch above for consistency (see
  // this function's and createProvider's doc comments).
  const { SimpleFinAdapter } = await import('@clad/simplefin-adapter')

  // Throws TokenStoreKeyError (already redacted) on a wrong passphrase —
  // propagate so the server fails fast instead of serving with a broken store.
  const tokenStore = new SqliteTokenStore({ dbPath, passphrase })

  return new SimpleFinAdapter({ tokenStore, dbPath, passphrase })
}
