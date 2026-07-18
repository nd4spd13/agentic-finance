import { useEffect, useState } from 'react'
import type { McpServerStatus } from '../../../shared/ipc.js'
import * as s from '../styles.js'

const STATE_COLOR: Record<McpServerStatus['state'], string> = {
  running: '#1e7a34',
  starting: '#8a6d00',
  stopping: '#8a6d00',
  stopped: '#666',
  crashed: '#b3261e',
}

const STATE_LABEL: Record<McpServerStatus['state'], string> = {
  running: 'Running',
  starting: 'Starting…',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  crashed: 'Crashed',
}

/**
 * D1.2: server status + start/stop/restart. Subscribes to live pushes over
 * `onMcpStatusChanged` (see preload/index.ts) rather than polling.
 */
export default function ServerStatusPanel(): JSX.Element {
  const [status, setStatus] = useState<McpServerStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.clad.getMcpStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    const unsubscribe = window.clad.onMcpStatusChanged((s) => setStatus(s))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  async function handle(action: () => Promise<McpServerStatus>): Promise<void> {
    setBusy(true)
    try {
      const next = await action()
      setStatus(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={s.card}>
      <h2 style={{ marginTop: 0 }}>MCP server</h2>
      {!status ? (
        <p style={s.mutedText}>Loading…</p>
      ) : (
        <>
          <p>
            <strong style={{ color: STATE_COLOR[status.state] }}>● {STATE_LABEL[status.state]}</strong>
            {typeof status.pid === 'number' && <span style={s.mutedText}> · pid {status.pid}</span>}
          </p>
          <p style={s.mutedText}>
            {status.tools.length > 0
              ? `${status.tools.length} tool${status.tools.length === 1 ? '' : 's'} available: ${status.tools.join(', ')}`
              : 'No tools reported yet.'}
          </p>
          <p style={s.mutedText}>
            Pending approvals: {status.pendingApprovals}
            {status.restartAttempt > 0 && ` · auto-restart attempts: ${status.restartAttempt}`}
          </p>
          {status.lastError && <p style={s.errorText}>{status.lastError}</p>}
          {/* Deliberately `mutedText`, not `errorText`/`warnText` — this is the
              "no agent configured, defaulted to one of several" notice, which
              is a healthy server's normal choice, not a problem to flag. See
              `McpServerStatus.agentNotice`'s doc in shared/ipc.ts. */}
          {status.agentNotice && <p style={s.mutedText}>{status.agentNotice}</p>}

          <button
            type="button"
            style={s.button}
            disabled={busy || status.state === 'starting' || status.state === 'running'}
            onClick={() => handle(() => window.clad.startMcpServer())}
          >
            Start
          </button>
          <button
            type="button"
            style={s.buttonSecondary}
            disabled={busy || status.state === 'stopped' || status.state === 'stopping'}
            onClick={() => handle(() => window.clad.stopMcpServer())}
          >
            Stop
          </button>
          <button
            type="button"
            style={s.buttonSecondary}
            disabled={busy}
            onClick={() => handle(() => window.clad.restartMcpServer())}
          >
            Restart
          </button>
        </>
      )}
    </div>
  )
}
