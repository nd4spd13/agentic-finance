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
 * WHERE THE RESOLVED ID GOES NOW (changed by the v0.5.0 regression fix): it
 * is no longer written into Claude Desktop's config file — since PR #68 that
 * entry is an `mcp-remote` proxy carrying no env at all, and the process that
 * actually serves Claude Desktop's calls is this app's own supervised child.
 * So the resolved id is persisted to `config.agent_id` and injected into that
 * child's `CLAD_AGENT_ID` (`resolveSupervisedAgentId` below ->
 * `mcp-server-manager.ts` -> `mcp-server-env.ts`). The bug described above is
 * therefore the same bug that shipped in v0.5.0, one process to the left; see
 * `config.ts`'s `agent_id` doc comment for that history.
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

export interface SupervisedAgentResolution {
  /** The agent id to put in the supervised child's `CLAD_AGENT_ID`. Always non-empty. */
  agentId: string
  /** Every agent id found in the policy (empty when the policy is missing/empty/invalid). */
  availableAgentIds: string[]
  /**
   * A user-facing explanation of why `agentId` isn't simply the configured
   * one — surfaced through `McpProcessStatus.lastError` (and from there the
   * status panel) by `mcp-server-manager.ts`. `undefined` means "the resolved
   * id is a real agent in the policy and is exactly what was asked for", i.e.
   * nothing to tell the user.
   *
   * This exists because the alternative is the v0.5.0 failure mode itself:
   * the child comes up looking perfectly healthy ('running', tools listed)
   * while every single tool call is denied, with the only evidence buried in
   * the child's stderr. A resolution problem here has to be visible in the UI.
   */
  warning?: string
}

/**
 * Resolves the identity the desktop app's SUPERVISED MCP child runs as
 * (`CLAD_AGENT_ID`), given whatever `config.agent_id` currently holds.
 *
 * Thin wrapper over `resolveClaudeDesktopAgentId` above rather than a second
 * resolution algorithm — the connect screen's preview and the child's actual
 * identity MUST agree about which agent a given policy + selection resolves
 * to, and the only way to guarantee that is to run the same code. The extra
 * job this one does is classifying the outcome into a `warning` the status UI
 * can show:
 *
 *   - configured id exists in the policy -> use it, no warning (normal case).
 *   - configured id is EMPTY (fresh config, or any config.json written before
 *     `agent_id` existed) -> deterministic sorted-first real agent, no
 *     warning: this isn't a misconfiguration, it's the backward-compatible
 *     default, and it's a valid identity.
 *   - configured id is set but ABSENT from the policy (user renamed/removed
 *     the agent after selecting it) -> fall back to the sorted-first real
 *     agent and warn. Running as a real agent beats running as a name the
 *     policy has never heard of, which denies everything.
 *   - policy missing/empty/schema-invalid -> `FALLBACK_AGENT_ID` and warn
 *     with the underlying reason. Calls will still be denied (there is no
 *     valid identity to be had), but the user is told exactly why instead of
 *     being left to guess.
 */
export async function resolveSupervisedAgentId(
  policyPath: string,
  configuredAgentId?: string
): Promise<SupervisedAgentResolution> {
  const requested = configuredAgentId?.trim() || undefined
  const resolution = await resolveClaudeDesktopAgentId(policyPath, requested)

  if (resolution.fallbackReason) {
    return {
      agentId: resolution.agentId,
      availableAgentIds: resolution.availableAgentIds,
      warning: `MCP tool calls will be denied: ${resolution.fallbackReason}`,
    }
  }

  if (requested && resolution.agentId !== requested) {
    return {
      agentId: resolution.agentId,
      availableAgentIds: resolution.availableAgentIds,
      warning:
        `The configured MCP agent '${requested}' is not defined in the policy at ${policyPath} ` +
        `(it defines: ${resolution.availableAgentIds.join(', ')}). Running as '${resolution.agentId}' instead — ` +
        `tool calls are evaluated against that agent's permissions. Pick an agent again in "Connect to Claude Desktop", ` +
        `or add '${requested}' back to the policy.`,
    }
  }

  return { agentId: resolution.agentId, availableAgentIds: resolution.availableAgentIds }
}
