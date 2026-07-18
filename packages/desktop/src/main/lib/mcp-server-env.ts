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
 * v0.5.0 regression fix: also sets `CLAD_AGENT_ID` from `config.agent_id`.
 * Omitting it was what made every Claude Desktop tool call fail with
 * `Denied: unknown agent: default-agent` once PR #68 routed those calls
 * through this child — see `config.ts`'s `agent_id` doc comment for the full
 * mechanism, and the inline comment at the assignment for the
 * config-beats-inherited-env precedence decision.
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

/**
 * Transport selection for the spawned child (D5.3 WS1). The desktop app's own
 * supervised child runs in `'http'` mode on a loopback port so Claude Desktop
 * can reach real provider data through `mcp-remote` (see `mcp-server-manager.ts`
 * and `claude-desktop-config.ts`). Omitted / `'stdio'` keeps the original
 * single-client stdio behaviour (what every existing caller/test relies on).
 */
export interface McpTransportOptions {
  transport?: 'stdio' | 'http'
  /** Loopback port for `transport: 'http'`; ignored otherwise. */
  httpPort?: number
}

export function buildServerEnv(
  config: CladConfig,
  secrets?: McpSpawnSecrets,
  transportOpts?: McpTransportOptions
): Record<string, string> {
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

  // Agent identity. Set AFTER the `...process.env` spread above, so a
  // configured `agent_id` deliberately WINS over an inherited
  // `CLAD_AGENT_ID`.
  //
  // Precedence decision (config > inherited env): the inherited value is
  // whatever happened to be in the environment that launched the Electron app
  // — a shell export, a launchd plist, a leftover from a terminal session —
  // and the user has no way to see or change it from inside the app. The
  // configured value is an explicit, visible, in-app choice made in the
  // connect screen's agent selector. Letting an invisible ambient value
  // silently override the visible one would make the selector lie, which is
  // exactly the class of bug this change exists to fix. Users who were
  // exporting `CLAD_AGENT_ID` as a workaround for that bug should now pick
  // the agent in the UI instead; the export keeps working only while
  // `agent_id` is unset.
  //
  // Empty `agent_id` (fresh config, or a config.json predating the field)
  // leaves any inherited `CLAD_AGENT_ID` untouched and otherwise lets
  // `server-core.ts` apply its own fallback — but `mcp-server-manager.ts`
  // resolves a real policy agent before calling this, so in practice the
  // supervised child always gets an explicit, policy-valid identity.
  //
  // `CLAD_AGENT_ID_ARG` (the CLI's `clad serve --agent-id`) is NOT set here
  // and still outranks this in `server-core.ts` — the CLI path is unchanged.
  if (config.agent_id) {
    env.CLAD_AGENT_ID = config.agent_id
  }

  if (transportOpts?.transport === 'http') {
    env.CLAD_MCP_TRANSPORT = 'http'
    env.CLAD_MCP_HTTP_PORT = String(transportOpts.httpPort ?? '')
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
