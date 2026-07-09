/**
 * Constructs the `FinancialDataProvider` for the desktop app's own in-process
 * use (D2.3 dashboard). Mirrors `packages/mcp-server/src/provider-factory.ts`
 * field-for-field, but reads its inputs from already-resolved desktop
 * config/secrets (dependency-injected — see `ProviderFactoryInput` below)
 * instead of `process.env`: the desktop app has no shell to set
 * `PLAID_CLIENT_ID`/`PLAID_SECRET`/`CLAD_TOKEN_PASSPHRASE` from, so those
 * live behind `safeStorage` (`plaid-secrets.ts`, `passphrase.ts`) and are
 * passed in directly instead.
 *
 * Provider-agnostic by construction (desktop-app.md D2.3: "when the
 * SimpleFIN adapter lands on main ... it should slot in via the same
 * factory pattern with no dashboard changes"): callers (`dashboard-data.ts`)
 * only ever see the `FinancialDataProvider` interface, never a
 * provider-specific type. Adding a `'simplefin'` branch here later is the
 * only change a future PR needs to make.
 *
 * Same S0.2 rule as everywhere else under `src/main/**`: `@clad/core` /
 * `@clad/plaid-adapter` are ESM-only and crash the CJS main bundle on a
 * static import — this module only ever reaches them through
 * `getCladCore()` / `getCladPlaidAdapter()` (enforced by the desktop
 * eslint override). Type references use the inline `import('@clad/core')...`
 * form (a `TSImportType`, not an `ImportDeclaration`) so even type-only
 * usage never trips that rule or risks a real bundled import.
 */

import { getCladCore } from './clad-core.js'
import { getCladPlaidAdapter } from './plaid-adapter.js'
import type { CladConfig } from './config.js'

export interface ProviderFactoryInput {
  config: CladConfig
  /** `null` when Plaid credentials haven't been saved yet (see `plaid-secrets.ts`). Ignored entirely when `config.provider === 'dummy'`. */
  plaidCredentials: { clientId: string; secret: string } | null
  /** `null` when passphrase custody isn't resolved yet (e.g. CLI-migration prompt still pending). Ignored entirely when `config.provider === 'dummy'`. */
  passphrase: string | null
}

export type ProviderFactoryResult =
  | { ok: true; provider: import('@clad/core').FinancialDataProvider }
  | { ok: false; error: string }

/** Human-readable, display-safe list of what's missing before `plaid` can be used — shared by `createFinancialProvider` and `dashboard-data.ts`'s own pre-flight check so the two can never disagree about "is this configured". */
export function missingPlaidPrereqs(input: Pick<ProviderFactoryInput, 'plaidCredentials' | 'passphrase'>): string[] {
  const missing: string[] = []
  if (!input.plaidCredentials) missing.push('Plaid Client ID/Secret (add them in Settings)')
  if (!input.passphrase) missing.push('a resolved token-store passphrase (finish the migration/setup prompt first)')
  return missing
}

/**
 * A cheap identity for "does the provider need to be rebuilt", used by
 * `dashboard-data.ts` to reuse one long-lived provider instance across
 * repeated manual refreshes instead of opening a fresh `SqliteTokenStore`/
 * `PlaidCache` handle (and its underlying `node:sqlite` connection) on every
 * click — those are never explicitly closed by `PlaidAdapter` (it has no
 * `close()`), so leaving the old one to be garbage-collected instead of
 * reused would accumulate open file handles over a long session. Never
 * embeds credential/passphrase *values*, only whether each is present, even
 * though this string never crosses IPC.
 */
export function providerFingerprint(input: ProviderFactoryInput): string {
  const { config, plaidCredentials, passphrase } = input
  return [
    config.provider,
    config.plaid_env,
    config.plaid_db,
    plaidCredentials ? 'creds:set' : 'creds:unset',
    passphrase ? 'pass:set' : 'pass:unset',
  ].join('|')
}

export async function createFinancialProvider(input: ProviderFactoryInput): Promise<ProviderFactoryResult> {
  const { config, plaidCredentials, passphrase } = input

  if (config.provider === 'dummy') {
    const { DummyDataProvider } = await getCladCore()
    return { ok: true, provider: new DummyDataProvider() }
  }

  const missing = missingPlaidPrereqs({ plaidCredentials, passphrase })
  if (missing.length > 0) {
    return {
      ok: false,
      error: `The Plaid provider is selected but not fully set up. Missing: ${missing.join('; ')}.`,
    }
  }

  try {
    const { PlaidAdapter, SqliteTokenStore, createPlaidClient } = await getCladPlaidAdapter()
    const client = createPlaidClient({
      clientId: plaidCredentials!.clientId,
      secret: plaidCredentials!.secret,
      env: config.plaid_env,
    })
    const tokenStore = new SqliteTokenStore({ dbPath: config.plaid_db, passphrase: passphrase! })
    const provider = new PlaidAdapter({ client, tokenStore, dbPath: config.plaid_db })
    return { ok: true, provider }
  } catch (err) {
    const { redactSecrets } = await getCladCore()
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: redactSecrets(message) }
  }
}
