/**
 * Assembles the environment for the desktop app's own spawned MCP server
 * child — the D1.2 half of the S0 spike's carry-forward item (b): "deciding
 * whether mcp-server's spawn env should keep using a temp per-launch
 * policy/audit/approval set (as the spike did) versus the real ~/.clad/*
 * paths via a ported config.ts". Resolved here: real config paths, always;
 * provider-specific secrets only when the matching provider is selected and
 * its prereqs are available (the caller — `McpServerManager` — pre-flights
 * that and never calls this with a mismatched combination, but this function
 * stays defensive: no `secrets` in, no provider-specific env vars out):
 *
 *  - `'plaid'`: `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` /
 *    `CLAD_TOKEN_PASSPHRASE`, from `secrets.plaid`.
 *  - `'simplefin'`: `CLAD_TOKEN_PASSPHRASE` only, from `secrets.simplefin` —
 *    mirrors `createSimpleFinProvider`'s env reads in
 *    `packages/mcp-server/src/provider-factory.ts` (the reference
 *    implementation): no client id/secret/env triad, just the token-store
 *    passphrase.
 *
 * Mirrors `packages/cli/src/commands/serve.ts` field-for-field for the
 * non-secret vars (`CLAD_POLICY_PATH`/`CLAD_AUDIT_DB`/`CLAD_APPROVAL_DB`/
 * `CLAD_PROVIDER`/`CLAD_PLAID_DB`/`CLAD_SIMPLEFIN_DB` — that file forwards
 * both DB paths unconditionally regardless of the active provider, and this
 * function does the same for consistency), plus `ELECTRON_RUN_AS_NODE: '1'`
 * since the child here is always the Electron binary itself (S0.4 finding)
 * rather than a system `node`.
 *
 * D3.3: `CLAD_PLAID_DB` is resolved through `effectivePlaidDbPath` (not
 * `config.plaid_db` directly) so the spawned server opens the SAME env-scoped
 * SQLite file the desktop app itself is using — `config` here is always
 * expected to already be the *effective* config (see `main/index.ts`'s
 * `loadEffectiveConfig`, which normalizes `plaid_env` to `'production'` for
 * a packaged build before it ever reaches this function), so `PLAID_ENV`
 * below and the derived `CLAD_PLAID_DB` path always agree with each other
 * and with what the desktop app itself is doing — the child never sees a
 * sandbox path/env pair while the parent app is running production, or
 * vice versa.
 *
 * Pure object construction — no `electron` import, safe to unit-test.
 */

import { effectivePlaidDbPath, type CladConfig } from './config.js'

export interface PlaidSpawnSecrets {
  clientId: string
  secret: string
  /** The token-store passphrase — see passphrase.ts. */
  passphrase: string
}

export interface SimpleFinSpawnSecrets {
  /** The token-store passphrase — see passphrase.ts. Same passphrase/store mechanism `PlaidSpawnSecrets.passphrase` uses (both back onto `@clad/core`'s `SqliteTokenStore`), just with no accompanying client id/secret. */
  passphrase: string
}

export interface McpSpawnSecrets {
  /** Only consulted when `config.provider === 'plaid'`. */
  plaid?: PlaidSpawnSecrets
  /** Only consulted when `config.provider === 'simplefin'`. */
  simplefin?: SimpleFinSpawnSecrets
}

export function buildServerEnv(config: CladConfig, secrets?: McpSpawnSecrets): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAD_POLICY_PATH: config.policy_path,
    CLAD_AUDIT_DB: config.audit_db,
    CLAD_APPROVAL_DB: config.approval_db,
    CLAD_PROVIDER: config.provider,
    CLAD_PLAID_DB: effectivePlaidDbPath(config, config.plaid_env),
    CLAD_SIMPLEFIN_DB: config.simplefin_db,
    // The spawned child is always the Electron binary run as plain Node
    // (see mcp-server-path.ts's doc comment) — never a system `node`.
    ELECTRON_RUN_AS_NODE: '1',
  }

  if (config.provider === 'plaid' && secrets?.plaid) {
    env.PLAID_CLIENT_ID = secrets.plaid.clientId
    env.PLAID_SECRET = secrets.plaid.secret
    env.PLAID_ENV = config.plaid_env
    env.CLAD_TOKEN_PASSPHRASE = secrets.plaid.passphrase
  }

  if (config.provider === 'simplefin' && secrets?.simplefin) {
    env.CLAD_TOKEN_PASSPHRASE = secrets.simplefin.passphrase
  }

  return env
}
