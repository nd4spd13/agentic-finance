import { useEffect, useState } from 'react'
import type { ClaudeDesktopConnectPreview } from '../../../shared/ipc.js'
import * as s from '../styles.js'

/**
 * D1.4: "Connect to Claude Desktop" — one button that ports
 * `scripts/setup-mcp.js`'s mechanic into the app, targeting Claude Desktop's
 * own `claude_desktop_config.json` instead of Claude Code's. Loads a
 * current-vs-proposed JSON preview on mount and shows it for explicit
 * confirmation before anything is written — never writes on its own. See
 * `main/lib/claude-desktop-config.ts`'s module doc for why the written `clad`
 * entry is a bare `mcp-remote` proxy carrying no secrets and no `CLAD_*` env
 * at all, and `main/lib/claude-desktop-path.ts` for the per-platform path
 * lookup.
 *
 * D5.3 Wave 6 (the flag flip): connecting no longer determines what identity
 * Claude Desktop's tool calls run under. The loopback server is now a real
 * OAuth 2.1 resource server (`CLAD_MCP_AUTH=oauth`, always on for this
 * child); `mcp-remote` transparently completes the OAuth dance on Claude
 * Desktop's behalf the first time it calls a tool (and again after a
 * revoke), popping a ONE-TIME browser consent page where a human picks the
 * profile for THAT connection. See `.claude/plans/d5.3/WS4-consent-revocation-ui.md`
 * §3 and `main/lib/claude-desktop-config.ts`'s CONSTRAINTS doc comment for
 * the full mechanism.
 *
 * THE AGENT SELECTOR BELOW IS NOW VESTIGIAL for that purpose (superseding the
 * "THE AGENT SELECTOR IS FUNCTIONAL" v0.5.0-regression-fix note this comment
 * used to lead with). Confirming still does exactly what it always did —
 * writes the proxy entry, persists the picked agent to `config.agent_id`,
 * and restarts the supervised child so it re-asserts that `CLAD_AGENT_ID` —
 * but `resolvePrincipal` (`server-core.ts`) reads `resources.agentId`
 * (`CLAD_AGENT_ID`) ONLY on the branch where `resources.authRequired` is
 * false. This child's `authRequired` is now unconditionally TRUE (Wave 6),
 * so that branch never runs for it at all: every request either carries a
 * verified OAuth profile or is rejected outright (`UnauthenticatedError` /
 * the transport's 401), full stop — `CLAD_AGENT_ID` is dead code for this
 * child's tool-call handling, not a fallback that merely got harder to
 * reach. No real Claude Desktop tool call is evaluated against this pick
 * anymore — the profile a connection actually runs as is chosen once, per
 * client, on the browser consent page. Kept functional (not removed)
 * because `resolveSupervisedAgentId`/`agent-resolution.ts` still validates
 * this pick against the policy and surfaces the result as the status
 * panel's policy-validity warning; the copy below says so rather than let
 * the selector imply it still controls Claude Desktop specifically.
 *
 * Per-connection authenticated identity (D5.3 WS3) is now live, so the old
 * "single PROCESS-level identity shared by every MCP client" limitation this
 * comment used to describe no longer holds — Claude Desktop and Claude Code
 * connected at once each get their own bound profile. See the Connect tab's
 * "Connected clients" section (`ConnectedClients.tsx`) to see and revoke
 * individual connections.
 */
export default function ConnectClaudeDesktop(): JSX.Element {
  const [preview, setPreview] = useState<ClaudeDesktopConnectPreview | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function load(agentId?: string): Promise<void> {
    setLoadError(null)
    try {
      const next = await window.clad.getClaudeDesktopConnectPreview(agentId)
      setPreview(next)
      setSelectedAgentId(next.resolvedAgentId)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleAgentChange(nextAgentId: string): Promise<void> {
    setSelectedAgentId(nextAgentId)
    await load(nextAgentId)
  }

  async function handleConfirm(): Promise<void> {
    setConnecting(true)
    setResult(null)
    try {
      const res = await window.clad.connectClaudeDesktop(selectedAgentId)
      setResult({
        ok: res.ok,
        text: res.ok
          ? 'Connected. Restart Claude Desktop to load the clad tools — it will prompt you to approve access in your browser the first time it calls one.'
          : res.error ?? 'Failed to connect.',
      })
      if (res.ok) {
        setConfirming(false)
        await load(selectedAgentId)
      }
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div style={s.card}>
      <h2 style={{ marginTop: 0 }}>Connect to Claude Desktop</h2>
      <p style={s.mutedText}>
        Adds a <code>clad</code> MCP server entry to Claude Desktop&apos;s config so it can list and call the
        same tools (<code>clad_get_balances</code>, <code>clad_safe_to_spend</code>, …) this app&apos;s own MCP
        server exposes. The entry points Claude Desktop at this app&apos;s local MCP server, so it sees your real
        connected accounts — and Plaid credentials and the token-store passphrase never leave this app&apos;s
        keychain-backed storage or get written to another app&apos;s plaintext config file. Clad has to be running
        for Claude Desktop&apos;s tool calls to work.
      </p>
      <p style={s.mutedText}>
        After connecting, Claude Desktop will prompt you to <strong>approve access in your browser</strong> the
        first time it calls a tool — a one-time consent screen where you pick which profile that connection gets.
        Each connection gets its own identity this way; manage or revoke them afterward in the Connect tab&apos;s
        &quot;Connected clients&quot; section.
      </p>

      {loadError && <p style={s.errorText}>{loadError}</p>}
      {!preview && !loadError && <p style={s.mutedText}>Loading…</p>}

      {preview && !preview.installed && (
        <p style={s.errorText}>
          Claude Desktop was not found on this machine (expected its config at{' '}
          <code>{preview.configPath}</code>). Install Claude Desktop, launch it once, then come back here.
        </p>
      )}

      {preview && preview.installed && !confirming && (
        <>
          {preview.alreadyConnected ? (
            <p style={s.successText}>Already connected — Claude Desktop&apos;s config matches this entry.</p>
          ) : (
            <p style={s.mutedText}>Not connected yet.</p>
          )}
          <button type="button" style={s.button} onClick={() => setConfirming(true)}>
            {preview.alreadyConnected ? 'View / reconnect' : 'Connect to Claude Desktop'}
          </button>
        </>
      )}

      {preview && preview.installed && confirming && (
        <div>
          {preview.agentFallbackReason && <p style={s.warnText}>{preview.agentFallbackReason}</p>}

          {preview.availableAgentIds.length > 1 && (
            <>
              <label style={s.label} htmlFor="claude-desktop-agent">
                Fallback agent (does not control Claude Desktop&apos;s tool calls — see below)
              </label>
              <select
                id="claude-desktop-agent"
                style={s.select}
                value={selectedAgentId ?? preview.resolvedAgentId}
                disabled={connecting}
                onChange={(e) => handleAgentChange(e.target.value)}
              >
                {preview.availableAgentIds.map((agentId) => (
                  <option key={agentId} value={agentId}>
                    {agentId}
                  </option>
                ))}
              </select>
            </>
          )}

          {preview.availableAgentIds.length === 1 && (
            <p style={s.mutedText}>
              Policy&apos;s only agent: <code>{preview.resolvedAgentId}</code>
            </p>
          )}

          {preview.availableAgentIds.length > 0 && (
            <p style={s.mutedText}>
              This no longer controls Claude Desktop&apos;s tool calls. Claude Desktop&apos;s calls run as whichever
              profile you approve on the browser consent screen when it first connects — each connection gets its
              own, chosen there. This picker only sets Clad&apos;s own fallback agent (used elsewhere, e.g. by the
              status panel&apos;s policy check) and is kept here so you can still see/change it.
            </p>
          )}

          <p style={s.label as React.CSSProperties}>Current config ({preview.configPath})</p>
          <pre style={s.pathList}>{preview.currentConfigJson ?? '(file does not exist yet)'}</pre>
          <p style={s.label as React.CSSProperties}>Proposed config (after connecting)</p>
          <pre style={s.pathList}>{preview.proposedConfigJson}</pre>
          <button type="button" style={s.button} disabled={connecting} onClick={handleConfirm}>
            Confirm and write
          </button>
          <button
            type="button"
            style={s.buttonSecondary}
            disabled={connecting}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {result && <p style={result.ok ? s.successText : s.errorText}>{result.text}</p>}
    </div>
  )
}
