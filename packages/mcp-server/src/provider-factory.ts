import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DummyDataProvider, SqliteTokenStore, type FinancialDataProvider } from '@clad/core'
import { writeRedactedStderr } from './server-core.js'

/** The transport mode a real-provider gate cares about (`provider-factory.ts` §5). */
export type ProviderGateTransport = 'stdio' | 'http'

export interface ProviderGate {
  /** The transport this process is serving (`CLAD_MCP_TRANSPORT`). */
  transport: ProviderGateTransport
  /** True iff `CLAD_MCP_AUTH=oauth` (`ServerResources.authRequired`). */
  authRequired: boolean
}

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
 *
 * `gate` defaults to `{ transport: 'stdio', authRequired: false }` — the
 * pre-WS3 behaviour — so every existing call site/test that constructs a
 * provider without passing a gate (this file's own test suite included) sees
 * byte-identical behaviour to before this change.
 *
 * REAL-PROVIDER GATE (D5.3 WS3 §5) — STAGED, an orchestrator-sanctioned
 * deviation from the design doc's literal always-enforce snippet:
 *   - `authRequired === true` && a real provider (`plaid`/`simplefin`) &&
 *     `transport !== 'http'` -> throws. A real provider may never be
 *     constructed on stdio (or on a hypothetical non-http transport) once the
 *     operator has opted into auth enforcement.
 *   - `authRequired === false` && a real provider -> ALLOWED, with a one-line
 *     redacted stderr warning. This is the deliberate interim posture: WS3's
 *     own transition paragraph (§5) requires the beta's current behaviour to
 *     stay unchanged while `CLAD_MCP_AUTH` is off, and the design doc's literal
 *     "unauthenticated == always refuse a real provider" snippet would break
 *     two shipping paths that have no way to set `CLAD_MCP_AUTH=oauth` yet:
 *     the desktop app's supervised child (http transport + simplefin, no auth
 *     — the shipped v0.5/v0.6 configuration, `mcp-server-env.ts`) and the CLI
 *     `clad serve` (stdio transport + a real provider — `serve.ts` forwards
 *     `CLAD_PROVIDER` but never sets `CLAD_MCP_TRANSPORT`, so it always runs
 *     stdio). The full "real provider requires authenticated HTTP, full stop"
 *     gate activates once Wave 6 flips `CLAD_MCP_AUTH=oauth` on by default.
 *   - `authRequired === true` && real && `transport === 'http'` -> allowed,
 *     no warning (this IS the target state).
 *   - `dummy` is allowed everywhere and never warns.
 */
export async function createProvider(
  gate: ProviderGate = { transport: 'stdio', authRequired: false }
): Promise<FinancialDataProvider> {
  const provider = process.env.CLAD_PROVIDER ?? 'dummy'

  if (provider === 'dummy') {
    return new DummyDataProvider()
  }

  if (provider !== 'plaid' && provider !== 'simplefin') {
    throw new Error(
      `[clad server] Unknown CLAD_PROVIDER "${provider}". Expected "dummy", "plaid", or "simplefin".`
    )
  }

  if (gate.authRequired && gate.transport !== 'http') {
    throw new Error(
      '[clad server] A real provider requires the authenticated HTTP transport ' +
        '(CLAD_MCP_TRANSPORT=http, CLAD_MCP_AUTH=oauth).'
    )
  }

  if (!gate.authRequired) {
    // Interim posture (see doc comment above): no secret/env value here,
    // just the provider name (already user-controlled, non-secret) and a
    // static description of the risk.
    writeRedactedStderr(
      `[clad server] WARNING: CLAD_PROVIDER=${provider} is serving without CLAD_MCP_AUTH=oauth — ` +
        `requests are not yet gated by a verified token principal (interim beta posture, D5.3 WS3 §5).\n`
    )
  }

  if (provider === 'plaid') {
    return createPlaidProvider()
  }

  return createSimpleFinProvider()
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
