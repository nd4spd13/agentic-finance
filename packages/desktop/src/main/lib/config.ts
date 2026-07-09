/**
 * Config port for the Clad desktop app — main process only.
 *
 * Mirrors `packages/cli/src/config.ts` field-for-field (`~/.clad/config.json`
 * by default, `CLAD_CONFIG_DIR` override honored) so the CLI and the desktop
 * app read/write the SAME config directory and stay interoperable: agents
 * connected through either one see the same policy/audit/approval/token
 * data (desktop-app.md, "Context an agent needs"). This is a separate
 * module inside `packages/desktop`, not an edit of the CLI's file — the
 * phase's scope rules only allow touching packages outside desktop/docs when
 * strictly required, and duplicating ~80 lines of pure fs/path logic isn't.
 *
 * Desktop-only extension: `plaid_env`. The CLI treats `PLAID_ENV` as
 * env-var-only (never written to config.json — see `connect.ts`), but the
 * desktop app has no shell to set env vars from, so its chosen Plaid
 * environment has to be persisted somewhere non-secret. `config.json` is the
 * natural place (same non-secret status as `provider`). The CLI's own
 * `loadConfig` ignores unknown JSON fields, so a desktop-authored
 * config.json with `plaid_env` set round-trips fine through the CLI; the one
 * asymmetry is that if the CLI's own `saveConfig` is ever invoked against
 * such a file, it rewrites it without `plaid_env` (acceptable — `PLAID_ENV`
 * keeps working for the CLI via its normal env var either way).
 *
 * `plaid_env` values match the installed `plaid` SDK's `PlaidEnvironments`
 * map exactly (`sandbox` | `production` — Plaid's older `development`
 * environment is not present in the installed SDK version; verified against
 * `packages/plaid-adapter/node_modules/plaid/dist/configuration.js`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type CladProvider = 'dummy' | 'plaid'
export type PlaidEnvName = 'sandbox' | 'production'

export interface CladConfig {
  policy_path: string
  audit_db: string
  approval_db: string
  server_pid_file: string
  provider: CladProvider
  plaid_db: string
  plaid_env: PlaidEnvName
  /**
   * D1.3: whether closing the main window hides it (keeping the app + tray
   * running) instead of quitting. Defaults to `true` — standard menu-bar-app
   * behavior. See the window `close` handler in `src/main/index.ts`.
   */
  close_to_tray: boolean
  /**
   * D3.2: where the SimpleFIN `SqliteTokenStore`/`SimpleFinCache` live —
   * mirrors the CLI's `simplefin_db` field (`packages/cli/src/config.ts`) so
   * a paste-a-token connection made in the desktop app is visible to a CLI
   * pointed at the same `CLAD_CONFIG_DIR`, and vice versa. Unlike `plaid_env`
   * above, this isn't a desktop-only addition — it's filling in a field the
   * CLI's config has always had that this port simply hadn't needed until
   * D3.2. `provider` deliberately stays `'dummy' | 'plaid'` here (unchanged)
   * — D3.2 only wires the connect flow (claim + store), not routing the
   * dashboard/MCP server through SimpleFIN as the active provider; that's
   * `provider-factory.ts` follow-up work, out of scope for this task.
   */
  simplefin_db: string
}

export function getConfigDir(): string {
  return process.env.CLAD_CONFIG_DIR ?? join(homedir(), '.clad')
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export function defaultConfig(): CladConfig {
  const dir = getConfigDir()
  return {
    policy_path: join(dir, 'policy.yaml'),
    audit_db: join(dir, 'audit.sqlite'),
    approval_db: join(dir, 'approvals.sqlite'),
    server_pid_file: join(dir, 'server.pid'),
    provider: 'dummy',
    plaid_db: join(dir, 'plaid.sqlite'),
    plaid_env: 'sandbox',
    close_to_tray: true,
    simplefin_db: join(dir, 'simplefin.sqlite'),
  }
}

export function loadConfig(): CladConfig {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    return defaultConfig()
  }
  const raw = readFileSync(configPath, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<CladConfig>
  const defaults = defaultConfig()
  return {
    policy_path: parsed.policy_path
      ? resolve(parsed.policy_path.replace('~', homedir()))
      : defaults.policy_path,
    audit_db: parsed.audit_db
      ? resolve(parsed.audit_db.replace('~', homedir()))
      : defaults.audit_db,
    approval_db: parsed.approval_db
      ? resolve(parsed.approval_db.replace('~', homedir()))
      : defaults.approval_db,
    server_pid_file: parsed.server_pid_file
      ? resolve(parsed.server_pid_file.replace('~', homedir()))
      : defaults.server_pid_file,
    provider: parsed.provider === 'plaid' ? 'plaid' : defaults.provider,
    plaid_db: parsed.plaid_db
      ? resolve(parsed.plaid_db.replace('~', homedir()))
      : defaults.plaid_db,
    plaid_env: parsed.plaid_env === 'production' ? 'production' : defaults.plaid_env,
    close_to_tray:
      typeof parsed.close_to_tray === 'boolean' ? parsed.close_to_tray : defaults.close_to_tray,
    simplefin_db: parsed.simplefin_db
      ? resolve(parsed.simplefin_db.replace('~', homedir()))
      : defaults.simplefin_db,
  }
}

export function saveConfig(config: CladConfig): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function ensureConfigDir(): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Starter policy — written so the desktop app's default
 * `CLAD_AGENT_ID_ARG`-less server run (which falls back to
 * `'default-agent'`, see `packages/mcp-server/src/server.ts`) resolves
 * against a real, schema-valid policy entry instead of an empty or invalid
 * one.
 *
 * NOT byte-identical to `clad init`'s template
 * (`packages/cli/src/commands/init.ts`) despite an earlier version of this
 * comment claiming so: discovered during D1.3 manual QA (launching the app
 * and watching the supervised MCP server crash-loop on every fresh config
 * dir) that BOTH templates predate `@clad/core`'s current
 * `policy.schema.json`, which requires every agent entry to have a
 * top-level `description` string and to nest `accounts`/`transactions`/
 * `spending`/`escalation`/`audit` under a `permissions` object — neither of
 * which the old flat shape (`agents.default-agent.accounts`/`.transactions`
 * directly) provided. `parsePolicy` (`packages/core/src/policy/parser.ts`)
 * validates strictly (ajv, not just "best effort"), so the old shape made
 * `@clad/mcp-server`'s `main()` throw and `process.exit(1)` immediately —
 * on every single launch, for both the desktop app's own supervised server
 * AND (D1.4) Claude Desktop's spawned server, since both point at this same
 * file. Fixed here, scoped to `@clad/desktop`'s own copy; the CLI's
 * `init.ts` copy has the identical latent bug and needs the same fix
 * separately (out of scope for this package).
 *
 * Also drops the old `spending`/`escalation` blocks entirely rather than
 * inventing values for `EscalationConfig`'s now-required
 * `triggers`/`channel`/`timeout`/`default_on_timeout` fields (a materially
 * bigger commitment than "off by default" for a template the user hasn't
 * reviewed yet) — both are optional in `AgentPermissions`, and omitting
 * them preserves the original secure-by-default intent (no spending, no
 * escalation configured) without fabricating a channel/timeout that means
 * nothing until the user has actually set one up.
 */
const STARTER_POLICY = `# Clad Policy
# Generated by: Clad desktop app (first launch)
#
# Edit this file to control what AI agents can access.
# Docs: https://clad.dev/policy-reference

agents:
  default-agent:
    description: Default agent created on first launch. Edit to restrict access.
    permissions:
      accounts:
        visible: []          # Account IDs the agent can see; empty = all accounts
        balance: true
        account_number: false
        routing_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 30    # Only show transactions from the last N days
      audit:
        log_all_queries: true
        log_policy_evaluations: true
`

/**
 * First-run bootstrap: the desktop app has no interactive terminal to run
 * `clad init` in, so this runs the equivalent automatically and silently on
 * every launch. No-op (beyond filling genuine gaps) once a config dir
 * exists — never overwrites an existing `config.json` or `policy.yaml`,
 * whether desktop- or CLI-authored.
 */
export function ensureConfigBootstrap(): CladConfig {
  ensureConfigDir()
  const configPath = getConfigPath()
  const config = existsSync(configPath) ? loadConfig() : defaultConfig()

  if (!existsSync(configPath)) {
    saveConfig(config)
  }
  if (!existsSync(config.policy_path)) {
    writeFileSync(config.policy_path, STARTER_POLICY, 'utf-8')
  }

  return config
}

/**
 * Path for the desktop app's own token store when the user opts out of CLI
 * migration ("start fresh" — see `passphrase.ts`'s `resetToFreshRandom` and
 * the `migration:startFresh` IPC handler). Deliberately distinct from the
 * CLI's default `plaid.sqlite` so a pre-existing CLI-managed store is never
 * overwritten or otherwise touched by choosing this path.
 */
export function desktopOnlyPlaidDbPath(): string {
  return join(getConfigDir(), 'plaid-desktop.sqlite')
}
