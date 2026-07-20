/**
 * D1.4 / D5.3-WS6 — "Connect to Claude Desktop": writes the `clad` entry into
 * Claude Desktop's own `claude_desktop_config.json`.
 *
 * THE ENTRY IS AN `mcp-remote` INVOCATION, not a direct server spawn. This is
 * the fix for the "Claude Desktop sees 3 dummy accounts" bug. The original
 * D1.4 entry spawned `@clad/mcp-server` directly, but that path could NEVER
 * serve real data: Claude Desktop's config file is plaintext, and the
 * SimpleFIN/Plaid token-store passphrase must never be written into it (P4 /
 * security checklist). With no passphrase, the directly-spawned server can
 * only fall back to the `dummy` provider (`CLAD_PROVIDER` defaults to
 * `'dummy'`), which is exactly the 3 hardcoded dummy accounts users saw.
 *
 * The fix routes Claude Desktop to the desktop app's OWN supervised MCP child
 * instead — that child already holds the passphrase (injected in its env by
 * `mcp-server-manager.ts` / `mcp-server-env.ts`) and now speaks loopback HTTP
 * (`@clad/mcp-server`'s `http-transport.ts`). `mcp-remote` is the stdio↔HTTP
 * proxy that bridges Claude Desktop (which speaks stdio, and rejects
 * `localhost` URLs in native Custom Connectors) to that loopback HTTP server:
 *
 *   Claude Desktop -> mcp-remote (stdio) -> http://127.0.0.1:<port>/mcp -> already-unlocked child -> real data
 *
 * So NO secret and NO `CLAD_PROVIDER` go into `claude_desktop_config.json` —
 * the entry only names the `mcp-remote` proxy and the loopback URL.
 *
 * mcp-remote resolution (design decision): `mcp-remote` is a PINNED
 * `dependencies` entry of `@clad/desktop`, invoked by its ABSOLUTE bundled
 * path (`resolveMcpRemoteEntry`) with the resolved Electron binary run as
 * plain Node — NOT a bare `npx mcp-remote`. MCP clients spawn their servers in
 * a minimal environment where `node`/`npx` are usually not on PATH (the same
 * S0.4 finding that makes this file resolve absolute node + server paths);
 * `npx` would also reach the network / an uncontrolled global cache. See
 * `mcp-server-path.ts`'s `resolveMcpRemoteEntry` doc.
 *
 * CONSTRAINTS this entry inherits (documented for users in the connect UI):
 *   - The loopback server only works WHILE the Clad desktop app is running —
 *     the child is app-supervised. Claude Desktop tool calls fail cleanly if
 *     Clad isn't running.
 *   - D5.3 Wave 6 (the flag flip, `.claude/plans/d5.3/SEQUENCING.md` PR 8):
 *     the loopback port is now a REAL OAuth 2.1 resource server
 *     (`CLAD_MCP_AUTH=oauth`, always set for this child — `mcp-server-env.ts`)
 *     — it is NOT unauthenticated anymore. `mcp-remote` transparently runs
 *     the OAuth dance on Claude Desktop's behalf: its first tool call after
 *     connecting (and its first call after any revoke) gets a 401, which
 *     `mcp-remote` turns into dynamic client registration + an `/authorize`
 *     round trip that opens a one-time browser consent page
 *     (`@clad/mcp-server`'s `oauth/consent-http.ts`) — no config change and
 *     no re-running "Connect to Claude Desktop" required. An earlier version
 *     of this comment described this port as "unauthenticated for now" —
 *     that was the pre-D5.3 interim posture; superseded.
 *   - Per-connection authenticated identity (D5.3 WS3) is now live: the
 *     profile a client's calls actually run as is chosen by a HUMAN, on that
 *     browser consent page, per OAuth grant — not by this file, not by
 *     `CLAD_AGENT_ID`. Claude Desktop and Claude Code connected
 *     simultaneously each get their OWN bound profile now, resolved
 *     per-request from the verified token (`server-core.ts`'s
 *     `resolvePrincipal`) — they are no longer "one and the same agent to
 *     the policy engine", which used to be the accepted limitation here.
 *   - Consequence for THIS file: agent identity is still the supervised
 *     child's single env-asserted `CLAD_AGENT_ID` (the entry itself still
 *     carries none — mcp-remote cannot set the identity of an
 *     already-running child, and doesn't need to), and the connect UI's
 *     agent selector still WRITES it (persists the pick to `config.agent_id`
 *     and restarts the child — see `config.ts`'s `agent_id`,
 *     `mcp-server-env.ts`, and the `claudeDesktopConnect` handler in
 *     `main/index.ts`) — but that env var is now VESTIGIAL for what it
 *     actually decides: `resolvePrincipal` reads `resources.agentId` ONLY on
 *     the `!resources.authRequired` branch. This child's `authRequired` is
 *     unconditionally true as of Wave 6, so that branch never runs for it —
 *     every request either carries a verified OAuth profile or is rejected
 *     outright, full stop. `CLAD_AGENT_ID` is dead code for this child's
 *     tool-call handling, not merely a fallback that got harder to reach.
 *     This supersedes the v0.5.0 regression note this comment used to end
 *     on ("the selector is NOT informational" — true of the config WRITE,
 *     no longer true of what a real client's tool calls run as). See
 *     `ConnectClaudeDesktop.tsx`'s doc comment for the UI-facing version of
 *     this, and `.claude/plans/d5.3/WS4-consent-revocation-ui.md` §3.
 *
 * Every function here is a pure, DI'd operation over an explicit
 * `configPath` string (or plain objects) — no `electron` import, and no
 * reference to the *real* Claude Desktop config path — so the merge/diff
 * logic is unit-testable against temp files only, per the D1.4 testing
 * constraint ("do NOT write to the user's REAL Claude Desktop config during
 * testing"). `src/main/index.ts` is the only place that calls
 * `claudeDesktopConfigPath(app.getPath('appData'))` to get the real path.
 *
 * v0.7.1 fix #6 (live-QA finding (b)): `mcp-remote` keys its DCR client
 * identity, tokens, and OAuth callback-port coordination lockfile off
 * `MCP_REMOTE_CONFIG_DIR` (defaulting to `~/.mcp-auth` when unset — see
 * `mcp-remote`'s `getConfigDir()`). Before this fix, EVERY `mcp-remote`
 * invocation against this app's loopback server shared that one default
 * directory regardless of which host app spawned it, so Claude Desktop and
 * Claude Code (or any two clients pointed at the same loopback URL) silently
 * shared a single DCR client_id and token set — the second app's
 * `mcp-remote` found the first app's still-valid lockfile/tokens
 * (`coordination.ts`'s `checkLockfile`/`isLockValid`) and skipped its own
 * browser auth entirely, riding on Claude Desktop's already-approved
 * connection with no visible consent step. `buildCladMcpServerEntry` now
 * sets `MCP_REMOTE_CONFIG_DIR` to a directory scoped under Electron's own
 * `userData` (via `mcpRemoteConfigDir`), so Claude Desktop's connection gets
 * its own client identity, tokens, and callback coordination. See
 * `getting-started.md`'s "Connecting other MCP clients" section for the
 * matching guidance when wiring up Claude Code (or another
 * `mcp-remote`-based client) against the SAME loopback URL: it needs a
 * DIFFERENT directory (e.g. `.../mcp-remote/claude-code`) for the identical
 * reason. NOTE for the release notes: this changes the written config
 * entry, so an existing Claude Desktop connection re-authenticates ONCE the
 * next time it calls a tool after upgrading (a new `mcp-remote` identity
 * means no cached token under the new directory).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveMcpRemoteEntry } from './mcp-server-path.js'
import { mcpLoopbackUrl } from './mcp-loopback.js'

export interface McpServerEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * The per-app `mcp-remote` state directory for Claude Desktop's connection —
 * see this module's doc comment (v0.7.1 fix #6) for why this needs to be
 * distinct from any other app's `mcp-remote` invocation against the same
 * loopback URL. `userDataDir` is Electron's own `app.getPath('userData')`,
 * threaded in (not read here) to keep this a pure function like the rest of
 * this file.
 */
export function mcpRemoteConfigDir(userDataDir: string): string {
  return join(userDataDir, 'mcp-remote', 'claude-desktop')
}

/**
 * Builds the `clad` entry for Claude Desktop's `mcpServers` map: an
 * `mcp-remote` invocation targeting the desktop app's loopback HTTP MCP
 * server at `http://127.0.0.1:<port>/mcp`.
 *
 * `execPath` is threaded in (rather than read from `process.execPath` here)
 * so this stays a pure function of its inputs — callers pass the real
 * `process.execPath` (the Electron binary, run as plain Node via
 * `ELECTRON_RUN_AS_NODE`, exactly as `mcp-server-manager.ts` spawns its own
 * child) or a fake path in tests. `port` is the loopback port the supervised
 * child listens on — callers pass `resolveMcpHttpPort()` so the URL matches
 * what the manager actually binds. `mcpRemoteConfigDir` is this connection's
 * OWN `mcp-remote` state directory (see `mcpRemoteConfigDir()` above) —
 * callers pass `mcpRemoteConfigDir(app.getPath('userData'))`.
 *
 * Note the entry carries NO `CLAD_*` env vars and NO secrets: the loopback
 * child (not this proxy) owns the policy path, provider selection, and
 * passphrase. `mcp-remote` needs `ELECTRON_RUN_AS_NODE` so the Electron
 * binary runs it as plain Node, and `MCP_REMOTE_CONFIG_DIR` (v0.7.1 fix #6)
 * so it gets its own client identity instead of sharing one with whatever
 * else invokes `mcp-remote` against this same loopback URL. Both are plain
 * `env` map entries — the SAME shape Claude Desktop already has to honor for
 * `ELECTRON_RUN_AS_NODE` to work at all today, so no new plumbing is needed
 * on Claude Desktop's side for this to take effect.
 */
export function buildCladMcpServerEntry(execPath: string, port: number, mcpRemoteConfigDirPath: string): McpServerEntry {
  return {
    command: execPath,
    args: [resolveMcpRemoteEntry(), mcpLoopbackUrl(port)],
    env: {
      // The command is the Electron binary itself, run as plain Node — never a
      // system `node`, since a packaged app cannot assume the end user has
      // Node installed at all (S0.4 finding).
      ELECTRON_RUN_AS_NODE: '1',
      // v0.7.1 fix #6: this connection's own mcp-remote identity/token/
      // callback-coordination directory — see module doc comment.
      MCP_REMOTE_CONFIG_DIR: mcpRemoteConfigDirPath,
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
