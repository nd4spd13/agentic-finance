/**
 * D1.4 — "Connect to Claude Desktop": ports `scripts/setup-mcp.js`'s
 * mechanic (resolve absolute node + server paths, because MCP clients spawn
 * server processes with a minimal environment where `node` is usually not
 * on PATH) into the desktop app, targeting Claude Desktop's own
 * `claude_desktop_config.json` instead of Claude Code's `.mcp.json`/
 * `~/.claude/mcp.json`.
 *
 * Security note — the `clad` MCP server entry built here NEVER carries Plaid
 * credentials or the token-store passphrase, even when this app's own
 * `provider` setting is `'plaid'` (see `mcp-server-manager.ts`/
 * `mcp-server-env.ts`, which DO thread those through for the desktop app's
 * *own* supervised server child). Two independent reasons, either one
 * sufficient on its own:
 *
 *   1. Claude Desktop's config file is a plain, unencrypted JSON file that
 *      Claude Desktop itself must be able to read as plain JSON to spawn the
 *      child — there is no "seal it" option here the way `sealed-file.ts`
 *      seals the passphrase/Plaid-credential files. Writing secret material
 *      into it would violate the roadmap's P4 (encrypted local storage) and
 *      the security checklist's "no new files with secret material outside
 *      0600 sealed storage".
 *   2. Even setting P4 aside, `provider-factory.ts`'s `createProvider()`
 *      throws synchronously at server startup if `CLAD_PROVIDER=plaid` is
 *      set without all four of `PLAID_CLIENT_ID`/`PLAID_SECRET`/
 *      `PLAID_ENV`/`CLAD_TOKEN_PASSPHRASE` present — so writing a bare
 *      `CLAD_PROVIDER=plaid` with no credentials would make Claude
 *      Desktop's spawned server crash before it could even answer
 *      `tools/list`, failing this phase's acceptance criterion outright
 *      ("Claude Desktop lists clad tools").
 *
 * So the entry written here always runs the `dummy` provider — tool listing
 * (`clad_get_balances`, `clad_get_transactions`, etc.) is available either
 * way, since the MCP server's tool set does not depend on which provider is
 * selected (see the S0.4 "Spike results" note in desktop-app.md). Live Plaid
 * data through Claude Desktop specifically is out of scope for D1.4; Phase
 * D3's in-app connect flow doesn't have this constraint because it never
 * writes to another app's config file.
 *
 * Every function here is a pure, DI'd operation over an explicit
 * `configPath` string (or plain objects) — no `electron` import, and no
 * reference to the *real* Claude Desktop config path — so the merge/diff
 * logic is unit-testable against temp files only, per the D1.4 testing
 * constraint ("do NOT write to the user's REAL Claude Desktop config during
 * testing"). `src/main/index.ts` is the only place that calls
 * `claudeDesktopConfigPath(app.getPath('appData'))` to get the real path.
 *
 * D1 manual QA finding 2: `buildCladMcpServerEntry` now takes an explicit
 * `agentId` and always writes it as `CLAD_AGENT_ID` — see
 * `agent-resolution.ts`'s module doc for why (the previous version wrote no
 * `CLAD_AGENT_ID` at all, so the spawned server fell back to
 * `mcp-server/src/server.ts`'s hardcoded `'default-agent'`, which silently
 * fails every tool call against any real-world policy that doesn't happen to
 * define an agent by that exact name).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveMcpServerEntry } from './mcp-server-path.js'
import type { CladConfig } from './config.js'

export interface McpServerEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * Builds the `clad` entry for Claude Desktop's `mcpServers` map. `execPath`
 * is threaded in (rather than read from `process.execPath` here) so this
 * stays a pure function of its inputs — callers pass the real
 * `process.execPath` (the Electron binary, run as plain Node via
 * `ELECTRON_RUN_AS_NODE`, exactly as `mcp-server-manager.ts` spawns its own
 * child — see the S0.4 "Spike results" deviation note) or a fake path in
 * tests.
 *
 * `agentId` must be resolved by the caller via
 * `agent-resolution.ts`'s `resolveClaudeDesktopAgentId` — never omitted and
 * never passed through unvalidated, since a `CLAD_AGENT_ID` that doesn't
 * exist in the policy at `config.policy_path` makes the spawned server deny
 * every request (`policy/evaluator.ts`'s unknown-agent check).
 */
export function buildCladMcpServerEntry(
  config: CladConfig,
  execPath: string,
  agentId: string
): McpServerEntry {
  return {
    command: execPath,
    args: [resolveMcpServerEntry()],
    env: {
      // The child is always the Electron binary itself, run as plain Node —
      // never a system `node`, since a packaged app cannot assume the end
      // user has Node installed at all (S0.4 finding).
      ELECTRON_RUN_AS_NODE: '1',
      CLAD_POLICY_PATH: config.policy_path,
      CLAD_AUDIT_DB: config.audit_db,
      CLAD_APPROVAL_DB: config.approval_db,
      CLAD_AGENT_ID: agentId,
    },
  }
}

/**
 * Whether Claude Desktop looks installed on this machine: its app-support
 * directory (the parent of `claude_desktop_config.json`) exists. Does NOT
 * require the config file itself to exist — a fresh install may not have
 * written one yet, and that's still a valid "installed, no config yet"
 * state, distinct from "not installed at all".
 */
export function isClaudeDesktopInstalled(configPath: string): boolean {
  return existsSync(dirname(configPath))
}

/**
 * Reads and parses the existing config, tolerating a missing or malformed
 * file (both treated as "empty" — `{}`). Never throws: a malformed existing
 * file is exactly the case where a careful, non-destructive merge matters
 * most, not a reason to abort and leave the user stuck.
 */
export function readExistingConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {}
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Merges the `clad` entry into `existing` non-destructively: every other
 * top-level key (Claude Desktop has other settings besides `mcpServers`)
 * and every other `mcpServers.<name>` entry is preserved exactly; only
 * `mcpServers.clad` is added or overwritten.
 */
export function mergeCladEntry(
  existing: Record<string, unknown>,
  cladEntry: McpServerEntry
): Record<string, unknown> {
  const existingMcpServers =
    existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {}

  return {
    ...existing,
    mcpServers: {
      ...existingMcpServers,
      clad: cladEntry,
    },
  }
}

/** True when `existing.mcpServers.clad` already deep-equals `cladEntry` — connecting again would be a no-op. */
export function isAlreadyConnected(existing: Record<string, unknown>, cladEntry: McpServerEntry): boolean {
  const existingMcpServers =
    existing.mcpServers && typeof existing.mcpServers === 'object' ? (existing.mcpServers as Record<string, unknown>) : {}
  return JSON.stringify(existingMcpServers.clad) === JSON.stringify(cladEntry)
}

/** Pretty-printed (2-space, trailing newline) JSON — matches `saveConfig`'s formatting in `config.ts`. */
export function formatConfigJson(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2) + '\n'
}

/**
 * Writes the merged config, creating the parent directory if needed.
 * Callers MUST check `isClaudeDesktopInstalled` first — this function alone
 * doesn't refuse to write when Claude Desktop is absent, so that its own
 * unit tests can exercise a plain "write to this temp path" case without a
 * pre-existing directory.
 */
export function writeConfig(configPath: string, config: Record<string, unknown>): void {
  const dir = dirname(configPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(configPath, formatConfigJson(config), 'utf-8')
}
