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
import { basename, dirname, extname, join, resolve } from 'node:path'

export type CladProvider = 'dummy' | 'plaid' | 'simplefin'
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
   * D3.2.
   *
   * D3.2 only wired the connect flow (claim + store) — `provider` stayed
   * `'dummy' | 'plaid'` and nothing consumed a saved token yet. This
   * follow-up (feat/desktop-simplefin-provider) is that "route the
   * dashboard/MCP server through SimpleFIN as the active provider" work:
   * `provider` now includes `'simplefin'` (see `CladProvider` above), and
   * `main/lib/provider-factory.ts` / `main/lib/mcp-server-env.ts` know how to
   * build a real `SimpleFinAdapter` (in-process) / spawn the MCP child with
   * `CLAD_PROVIDER=simplefin` (out-of-process) from it.
   */
  simplefin_db: string
  /**
   * D5.3 WS5/WS4: where the `SqliteGrantStore` (registered OAuth clients,
   * consented grants, auth codes, tokens) lives — a sibling of `plaid_db`/
   * `simplefin_db`, not co-located with either (grants are a distinct
   * concern with a distinct lifecycle/UI — see
   * `.claude/plans/d5.3/WS5-grant-store.md` §2). Unlike `plaid_db`, there is
   * no per-env split: one grant store regardless of `plaid_env`. Opened with
   * the SAME already-resolved token-store passphrase every other provider
   * store in this app uses (`main/lib/connected-clients.ts`) — zero new key
   * custody, per WS5 §3's "Desktop wiring (WS4)" note.
   */
  grant_db: string
  /**
   * Which policy agent the desktop app's SUPERVISED MCP child asserts as its
   * identity (`CLAD_AGENT_ID` — see `mcp-server-env.ts`). Chosen by the user
   * in the "Connect to Claude Desktop" screen's agent selector, which is what
   * persists it here.
   *
   * REGRESSION THIS FIXES (v0.5.0): before PR #68, Claude Desktop spawned its
   * OWN server process from an entry that carried `CLAD_AGENT_ID`, so the
   * user's selection reached the server that served its calls. #68 replaced
   * that entry with an `mcp-remote` proxy pointing at this app's loopback HTTP
   * server, which moved every Claude Desktop tool call onto the SUPERVISED
   * child instead — and `buildServerEnv` set no `CLAD_AGENT_ID` at all, so
   * that child fell back to `server-core.ts`'s hardcoded `'default-agent'`.
   * Any policy not defining an agent by that exact name (the normal case once
   * a user edits the starter policy) then failed EVERY tool call with
   * `Denied: unknown agent: default-agent` (`policy/evaluator.ts`). Latent
   * before #68 only because the supervised child served nothing but
   * `tools/list`, which never consults policy.
   *
   * `''` is the "not chosen yet" sentinel, and is what BOTH a fresh
   * `defaultConfig()` and every pre-existing `config.json` on disk (which has
   * no `agent_id` key at all) resolve to. It deliberately does NOT default to
   * `'default-agent'` — hardcoding that name is the very bug above. Instead,
   * `''` means "resolve one from the policy at spawn time", which
   * `mcp-server-manager.ts` does via `agent-resolution.ts`'s
   * `resolveSupervisedAgentId` (deterministic sorted-first real agent, so an
   * `analyst`/`finance-agent` policy runs as `analyst` rather than as a name
   * the policy has never heard of).
   *
   * KNOWN LIMITATION (until D5.3/WS3): this is ONE process-level identity for
   * the whole loopback server, so EVERY MCP client connected through it —
   * Claude Desktop, Claude Code, any other `mcp-remote` consumer — shares it.
   * Per-connection authenticated identity is D5.3's WS3
   * (`.claude/plans/D5.3-authenticated-agent-identity-plan.md`).
   */
  agent_id: string
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
    grant_db: join(dir, 'grants.sqlite'),
    // '' = "resolve from the policy at spawn time" — see the field's doc
    // comment for why this is not 'default-agent'.
    agent_id: '',
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
    provider:
      parsed.provider === 'plaid' || parsed.provider === 'simplefin' ? parsed.provider : defaults.provider,
    plaid_db: parsed.plaid_db
      ? resolve(parsed.plaid_db.replace('~', homedir()))
      : defaults.plaid_db,
    plaid_env: parsed.plaid_env === 'production' ? 'production' : defaults.plaid_env,
    close_to_tray:
      typeof parsed.close_to_tray === 'boolean' ? parsed.close_to_tray : defaults.close_to_tray,
    simplefin_db: parsed.simplefin_db
      ? resolve(parsed.simplefin_db.replace('~', homedir()))
      : defaults.simplefin_db,
    // Backward compatibility: every config.json written before this field
    // existed simply has no `grant_db` key, which falls through to the
    // default sibling path (`~/.clad/grants.sqlite`) — same pattern as
    // `simplefin_db` above.
    grant_db: parsed.grant_db ? resolve(parsed.grant_db.replace('~', homedir())) : defaults.grant_db,
    // Backward compatibility: every config.json written before this field
    // existed simply has no `agent_id` key, which falls through to the `''`
    // sentinel — NOT to 'default-agent' (see the field's doc comment). A
    // whitespace-only value is treated the same as absent.
    agent_id: typeof parsed.agent_id === 'string' ? parsed.agent_id.trim() : defaults.agent_id,
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
        account_number: false # Masked last-4 account number; hidden unless explicitly true
        name: true            # Account name; visible unless explicitly false
        institution: true     # Financial institution; visible unless explicitly false
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
 *
 * Orthogonal to env scoping below: this only ever repoints the RAW
 * `plaid_db` config field (what `effectivePlaidDbPath` treats as the
 * `'production'` value). If the active env is `'sandbox'` at the time (or
 * afterward), `effectivePlaidDbPath(config, 'sandbox')` still derives its
 * sibling from whatever `plaid_db` currently is — e.g. after "start fresh"
 * that's `plaid-desktop-sandbox.sqlite`, not the CLI-adjacent
 * `plaid-sandbox.sqlite`. That's correct: "start fresh" exists specifically
 * to stop touching the CLI's file at all, in either env.
 */
export function desktopOnlyPlaidDbPath(): string {
  return join(getConfigDir(), 'plaid-desktop.sqlite')
}

/**
 * D3.3 — env-scoped Plaid token store/cache path. Plaid sandbox and
 * production are different backends with different Items; sharing one
 * SQLite file between them would intermingle unrelated data and break
 * lookups made against the "wrong" environment's tokens.
 *
 * `'production'` returns `config.plaid_db` UNCHANGED — this is load-bearing
 * for CLI interop: the CLI has no env scoping of its own (see
 * `packages/cli/src/config.ts` — one `plaid_db` field, full stop; `PLAID_ENV`
 * only selects which Plaid API it talks to, never which file it reads/
 * writes), so the desktop app's production env has to keep pointing at the
 * exact same path the CLI would use, byte-for-byte, or the two stop seeing
 * the same linked accounts.
 *
 * `'sandbox'` derives a sibling path in the same directory, same extension,
 * with a `-sandbox` suffix inserted before the extension (`plaid.sqlite` ->
 * `plaid-sandbox.sqlite`) — never a path the CLI has any reason to touch,
 * so a dev build switched to sandbox can never collide with (or silently
 * corrupt) a CLI-managed production store.
 *
 * Every desktop-side consumer of `config.plaid_db` (the token store itself,
 * `providerFingerprint`, the spawned MCP server's `CLAD_PLAID_DB`, the
 * CLI-migration detection, ...) must resolve its actual on-disk path through
 * this function rather than reading `config.plaid_db` directly — see each
 * call site's own doc comment for why.
 */
export function effectivePlaidDbPath(config: CladConfig, env: PlaidEnvName): string {
  if (env === 'production') return config.plaid_db
  const ext = extname(config.plaid_db)
  const base = basename(config.plaid_db, ext)
  return join(dirname(config.plaid_db), `${base}-sandbox${ext}`)
}

/**
 * D3.3 — packaged-build normalization: a packaged build is ALWAYS
 * `'production'`, regardless of what `config.json`'s `plaid_env` says (e.g.
 * a config authored by a dev build against the same `CLAD_CONFIG_DIR`, or
 * one hand-edited by the user). Applied at *read* time, never at *write*
 * time — `configSetProviderAndEnv`'s handler in `main/index.ts` still
 * rejects an attempt to persist `'sandbox'` from a packaged build outright,
 * but this function's job is to make sure that EVEN IF an already-sandbox
 * config.json is sitting there (the common case: a developer's own machine,
 * running both a dev build and a locally-built packaged one against the
 * same config dir), the packaged app never actually acts on it — no crash,
 * no silent sandbox usage, just a normalized read.
 *
 * Pure and `electron`-free like every other function in this module — real
 * callers pass `app.isPackaged` in from `main/index.ts` (the one place in
 * this app allowed to import `electron`); see that file's `loadEffectiveConfig`.
 */
export function effectivePlaidEnv(configuredEnv: PlaidEnvName, isPackaged: boolean): PlaidEnvName {
  return isPackaged ? 'production' : configuredEnv
}
