/**
 * CLAD-5: a policy save needs to actually reach the running agent, not just
 * the file on disk. The supervised MCP child (`mcp-server-manager.ts`)
 * parses `policy.yaml` ONCE at spawn time and holds it in memory for its
 * entire process lifetime — writing a new file (`writePolicy` in
 * `policy-data.ts`) never reaches an already-running child, and even a
 * client reconnect doesn't help, since the same long-lived child keeps
 * serving the reconnect. Before this, only a full app relaunch applied a
 * policy edit.
 *
 * `savePolicyAndRestartServer` below is the fix: write, then (if a child is
 * actually running) restart it so it re-parses the new file. It deliberately
 * goes through `McpServerManager.restart()` (stop() then start() — the exact
 * path `main/index.ts`'s own manual Restart button and the crash-auto-restart
 * loop already use) rather than a hand-rolled spawn. That matters because
 * `start()`/`spawnAndConnect()` is what re-resolves `CLAD_AGENT_ID` from the
 * CURRENT config + policy on every spawn (see `mcp-server-manager.ts`'s
 * AGENT IDENTITY doc) — a restart triggered here goes through that same
 * resolution, so it cannot regress to the v0.5.0 "child asserts
 * 'default-agent', denies everything" bug PR #71 fixed.
 *
 * Kept as a standalone DI'd module (not folded into `policy-data.ts` or
 * `main/index.ts`) for the same reason the rest of `main/lib/**` is: this
 * package's test suite only unit-tests pure/DI'd modules with no `electron`
 * import (see `vitest.config.ts`'s doc comment) — `main/index.ts` itself
 * boots real Electron APIs and is never imported by a test.
 */

import type { PolicyWriteResult } from '../../shared/ipc.js'
import { writePolicy } from './policy-data.js'
import type { McpProcessStatus } from './mcp-server-manager.js'

/**
 * The subset of `McpServerManager`'s public API this needs. The real
 * manager satisfies this structurally (no adapter needed at the call site in
 * `main/index.ts`); tests can pass a lighter fake.
 */
export interface McpRestartHandle {
  /**
   * Null when no child is currently running (or trying to be) — the exact
   * same "is there actually a live child worth restarting" signal
   * `main/index.ts`'s Claude Desktop connect handler already keys its own
   * restart-on-identity-change decision off of. Used here to decide whether
   * to attempt a restart at all: a policy save should never be what silently
   * turns a deliberately-stopped server back on.
   */
  getRunningAgentId: () => string | null
  restart: () => Promise<McpProcessStatus>
}

/**
 * Writes the policy file (via `writePolicy`, unchanged validate-then-write
 * behavior) and, on success, restarts the supervised MCP child if one is
 * currently running. Never turns a successful write into `ok: false` — a
 * restart failure is reported via `restart_error` alongside `ok: true`,
 * since the save itself already succeeded.
 */
export async function savePolicyAndRestartServer(
  policyPath: string,
  policy: unknown,
  mcp: McpRestartHandle
): Promise<PolicyWriteResult> {
  const writeResult = await writePolicy(policyPath, policy)
  if (!writeResult.ok) return writeResult

  if (mcp.getRunningAgentId() === null) {
    // No child running (or attempting to run) right now — nothing to
    // restart, and nothing went wrong.
    return { ok: true, server_restarted: false }
  }

  try {
    const status = await mcp.restart()
    if (status.state === 'running') {
      return { ok: true, server_restarted: true }
    }
    return {
      ok: true,
      server_restarted: false,
      restart_error:
        status.lastError ?? `The MCP server did not come back up after restarting (state: "${status.state}").`,
    }
  } catch (err) {
    return {
      ok: true,
      server_restarted: false,
      restart_error: err instanceof Error ? err.message : String(err),
    }
  }
}
