/**
 * Resolves which policy agent ID the "Connect to Claude Desktop" entry
 * (D1.4, `claude-desktop-config.ts`) should run as.
 *
 * Bug this fixes (D1 manual QA finding 2): the entry written by D1.4 set no
 * `CLAD_AGENT_ID`, so the server spawned by Claude Desktop always fell back
 * to `mcp-server/src/server.ts`'s hardcoded `'default-agent'`. That only
 * happened to work because the desktop app's OWN starter policy
 * (`config.ts`'s `STARTER_POLICY`) defines an agent literally named
 * `default-agent`. Any real-world policy that doesn't use that exact name —
 * e.g. the repro policy defining `analyst` and `finance-agent`, no
 * `default-agent` at all — makes every tool call fail with `unknown agent:
 * default-agent` (`policy/evaluator.ts`'s unknown-agent check), silently and
 * with no indication in the UI of why.
 *
 * Fix: always resolve an explicit agent ID that actually exists in the
 * policy at the `CLAD_POLICY_PATH` being written, before building the entry:
 *   - exactly one agent defined -> use it, no user input needed.
 *   - multiple agents defined -> the caller (the renderer's confirmation
 *     dialog, `ConnectClaudeDesktop.tsx`) shows a selector; `requestedAgentId`
 *     threads the user's pick back in. Absent a pick (first load), this
 *     still returns a deterministic default (alphabetically first) so the
 *     preview always shows a valid, working proposed config rather than a
 *     blank/invalid one — the selector lets the user change it before
 *     confirming.
 *   - policy missing, empty, or schema-invalid -> falls back to
 *     `'default-agent'` (matching the bootstrap starter policy) with a
 *     `fallbackReason` the dialog surfaces to the user, rather than failing
 *     the whole connect flow outright.
 *
 * Uses `@clad/core`'s real `parsePolicy` (via the dynamic-import seam in
 * `clad-core.ts` — see that module's doc for why a static import would crash
 * the main process) so this reads the policy with the exact same schema
 * validation the spawned MCP server itself uses — no risk of this resolving
 * an agent ID the server would then reject anyway.
 */

import { getCladCore } from './clad-core.js'

/** Matches `config.ts`'s `STARTER_POLICY` — the one agent guaranteed to exist in a freshly-bootstrapped policy. */
export const FALLBACK_AGENT_ID = 'default-agent'

export interface AgentResolution {
  /** The agent ID to write into the clad entry's `CLAD_AGENT_ID`. */
  agentId: string
  /** Every agent ID found in the policy (empty when the policy is missing/empty/invalid). */
  availableAgentIds: string[]
  /**
   * Set (and shown to the user) only when resolution fell back to
   * `FALLBACK_AGENT_ID` because the policy couldn't supply a real one —
   * missing, empty, or failing `@clad/core`'s schema validation.
   */
  fallbackReason?: string
}

export async function resolveClaudeDesktopAgentId(
  policyPath: string,
  requestedAgentId?: string
): Promise<AgentResolution> {
  try {
    const { parsePolicy } = await getCladCore()
    const policy = await parsePolicy(policyPath)
    const availableAgentIds = Object.keys(policy.agents ?? {})

    if (availableAgentIds.length === 0) {
      return {
        agentId: FALLBACK_AGENT_ID,
        availableAgentIds: [],
        fallbackReason: `No agents are defined in the policy at ${policyPath}; using '${FALLBACK_AGENT_ID}' (matches the starter policy). Add an agent in the policy file, then reconnect.`,
      }
    }

    if (requestedAgentId && availableAgentIds.includes(requestedAgentId)) {
      return { agentId: requestedAgentId, availableAgentIds }
    }

    // No (valid) explicit request — deterministic default so the preview
    // always has a concrete, working selection. Sorted so it's stable
    // across calls/policy re-reads, not dependent on object key order.
    const [defaultAgentId] = [...availableAgentIds].sort()
    return { agentId: defaultAgentId, availableAgentIds }
  } catch (err) {
    return {
      agentId: FALLBACK_AGENT_ID,
      availableAgentIds: [],
      fallbackReason: `Could not read the policy at ${policyPath} (${err instanceof Error ? err.message : String(err)}); using '${FALLBACK_AGENT_ID}' (matches the starter policy). Fix the policy file, then reconnect.`,
    }
  }
}
