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
 * provider-specific type. The `'simplefin'` branch below is that adapter
 * landing (feat/desktop-simplefin-provider) — `dashboard-data.ts` only had
 * to grow a parallel pre-flight check against the new
 * `missingSimpleFinPrereqs` helper, no provider-specific logic of its own.
 *
 * Same S0.2 rule as everywhere else under `src/main/**`: `@clad/core` /
 * `@clad/plaid-adapter` / `@clad/simplefin-adapter` are ESM-only and crash
 * the CJS main bundle on a static import — this module only ever reaches
 * them through `getCladCore()` / `getCladPlaidAdapter()` /
 * `getCladSimpleFinAdapter()` (enforced by the desktop eslint override).
 * Type references use the inline `import('@clad/core')...` form (a
 * `TSImportType`, not an `ImportDeclaration`) so even type-only usage never
 * trips that rule or risks a real bundled import.
 */

import { getCladCore } from './clad-core.js'
import { getCladPlaidAdapter } from './plaid-adapter.js'
import { getCladSimpleFinAdapter } from './simplefin-adapter.js'
import { effectivePlaidDbPath, type CladConfig } from './config.js'

export interface ProviderFactoryInput {
  config: CladConfig
  /** `null` when Plaid credentials haven't been saved yet (see `plaid-secrets.ts`). Ignored entirely unless `config.provider === 'plaid'` (in particular, ignored for `'simplefin'` — it has no client id/secret/env triad, only a token-store passphrase). */
  plaidCredentials: { clientId: string; secret: string } | null
  /** `null` when passphrase custody isn't resolved yet (e.g. CLI-migration prompt still pending). Ignored entirely when `config.provider === 'dummy'` — consulted by both `'plaid'` and `'simplefin'`, which share the same `@clad/core` `SqliteTokenStore` mechanism. */
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
 * Same shape/purpose as `missingPlaidPrereqs` above, but SimpleFIN needs
 * only the token-store passphrase — no client id/secret/env triad (its whole
 * pitch is no developer account and no company-held credentials; the only
 * "credential" is the per-item access URL a user obtains themselves via the
 * D3.2 connect flow, which this factory never touches directly). Mirrors
 * `createSimpleFinProvider`'s prereq check in
 * `packages/mcp-server/src/provider-factory.ts` (the reference
 * implementation this desktop factory follows).
 */
export function missingSimpleFinPrereqs(input: Pick<ProviderFactoryInput, 'passphrase'>): string[] {
  const missing: string[] = []
  if (!input.passphrase) missing.push('a resolved token-store passphrase (finish the migration/setup prompt first)')
  return missing
}

/**
 * A cheap identity for "does the provider need to be rebuilt", used by
 * `dashboard-data.ts` to reuse one long-lived provider instance across
 * repeated manual refreshes instead of opening a fresh `SqliteTokenStore`/
 * `PlaidCache`/`SimpleFinCache` handle (and its underlying `node:sqlite`
 * connection) on every click — neither `PlaidAdapter` nor `SimpleFinAdapter`
 * are ever explicitly closed (no `close()` method on either), so leaving the
 * old one to be garbage-collected instead of reused would accumulate open
 * file handles over a long session. Never embeds credential/passphrase
 * *values*, only whether each is present, even though this string never
 * crosses IPC.
 *
 * D3.3: embeds `effectivePlaidDbPath(config, config.plaid_env)` rather than
 * the raw `config.plaid_db` — that's the actual SQLite file
 * `createFinancialProvider` below opens, so the fingerprint is an honest
 * identity for "what on-disk resource is this provider instance actually
 * backed by", not just "what were the raw config inputs". `config.plaid_env`
 * is included too (redundantly, once paths are env-scoped) — kept
 * deliberately explicit rather than relying on the derived path alone to
 * imply it.
 */
export function providerFingerprint(input: ProviderFactoryInput): string {
  const { config, plaidCredentials, passphrase } = input
  return [
    config.provider,
    config.plaid_env,
    effectivePlaidDbPath(config, config.plaid_env),
    // Only folded in for 'simplefin' — a config edit to simplefin_db while
    // a different provider is active shouldn't invalidate that provider's
    // cached instance (matches the "only what this provider actually reads"
    // discipline the plaid_env/effective-path entries above already follow).
    config.provider === 'simplefin' ? config.simplefin_db : 'simplefin_db:n/a',
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

  if (config.provider === 'simplefin') {
    const missing = missingSimpleFinPrereqs({ passphrase })
    if (missing.length > 0) {
      return {
        ok: false,
        error: `The SimpleFIN provider is selected but not fully set up. Missing: ${missing.join('; ')}.`,
      }
    }

    try {
      const { SqliteTokenStore } = await getCladCore()
      const { SimpleFinAdapter } = await getCladSimpleFinAdapter()
      const tokenStore = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: passphrase! })
      const provider = new SimpleFinAdapter({ tokenStore, dbPath: config.simplefin_db })
      return { ok: true, provider }
    } catch (err) {
      const { redactSecrets } = await getCladCore()
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: redactSecrets(message) }
    }
  }

  // Only 'plaid' remains at this point (CladProvider is 'dummy' | 'plaid' | 'simplefin').
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
    // D3.3: the env-scoped path, not raw config.plaid_db — see
    // `effectivePlaidDbPath`'s doc comment (config.ts) for why 'production'
    // resolves to config.plaid_db verbatim (CLI interop) while 'sandbox'
    // resolves to a derived sibling file.
    const dbPath = effectivePlaidDbPath(config, config.plaid_env)
    const tokenStore = new SqliteTokenStore({ dbPath, passphrase: passphrase! })
    const provider = new PlaidAdapter({ client, tokenStore, dbPath })
    return { ok: true, provider }
  } catch (err) {
    const { redactSecrets } = await getCladCore()
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: redactSecrets(message) }
  }
}
