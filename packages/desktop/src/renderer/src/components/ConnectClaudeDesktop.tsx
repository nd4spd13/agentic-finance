import { useEffect, useState } from 'react'
import type { ClaudeDesktopConnectPreview } from '../../../shared/ipc.js'
import * as s from '../styles.js'

/**
 * D1.4: "Connect to Claude Desktop" — one button that ports
 * `scripts/setup-mcp.js`'s mechanic into the app, targeting Claude Desktop's
 * own `claude_desktop_config.json` instead of Claude Code's. Loads a
 * current-vs-proposed JSON preview on mount and shows it for explicit
 * confirmation before anything is written — never writes on its own. See
 * `main/lib/claude-desktop-config.ts`'s module doc for why the written
 * `clad` entry never carries Plaid secrets (it always runs the demo/dummy
 * provider), and `main/lib/claude-desktop-path.ts` for the per-platform path
 * lookup.
 *
 * D1 manual QA finding 2: the entry always needs a real `CLAD_AGENT_ID`
 * (see `agent-resolution.ts`'s module doc). When the policy defines more
 * than one agent, an inline selector lets the user pick which one Claude
 * Desktop's copy of the server should run as, before confirming — picking a
 * new one re-fetches the preview so `proposedConfigJson` always reflects the
 * currently-selected agent id.
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
          ? 'Connected. Restart Claude Desktop to load the clad tools.'
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
        server exposes. Claude Desktop&apos;s copy always runs the demo data provider — Plaid credentials and the
        token-store passphrase never leave this app&apos;s keychain-backed storage or get written to another
        app&apos;s plaintext config file.
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
                Run Claude Desktop&apos;s copy as agent
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
              Will run as the policy&apos;s only agent: <code>{preview.resolvedAgentId}</code>
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
