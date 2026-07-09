import { useCallback, useEffect, useState } from 'react'
import type { DisplayConfig, MigrationReason } from '../../shared/ipc.js'
import MigrationPrompt from './components/MigrationPrompt.js'
import SettingsForm from './components/SettingsForm.js'
import ServerStatusPanel from './components/ServerStatusPanel.js'
import ConnectClaudeDesktop from './components/ConnectClaudeDesktop.js'
import Dashboard from './components/Dashboard.js'
import PolicyEditor from './components/PolicyEditor.js'
import ApprovalsInbox from './components/ApprovalsInbox.js'
import AuditLogViewer from './components/AuditLogViewer.js'
import * as s from './styles.js'

// D2 nav: a minimal tab switcher for the "ready" phase below. Kept
// intentionally tiny (a union + one useState) — 'settings' is the original
// D1 shell content, unchanged; the other tabs are the D2 product surfaces.
type Tab = 'dashboard' | 'approvals' | 'audit' | 'policy' | 'settings'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'migration-needed'; plaidDbPath: string; reason: MigrationReason }
  | { phase: 'ready'; config: DisplayConfig }

/**
 * D1 shell (settings screen: paths, provider/Plaid env, Plaid credentials,
 * close-to-tray; the one-time CLI-migration prompt; MCP server status/
 * controls from D1.2; the Connect-to-Claude-Desktop action from D1.4) plus
 * the D2 product tabs: the D2.1 approvals inbox, the D2.2 audit log viewer,
 * the D2.3 dashboard (balances + recent transactions), and the D2.4 policy
 * editor. Tray/menu-bar presence (D1.3) lives entirely in the main process
 * (`src/main/index.ts`) — nothing to render here.
 */
export default function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [tab, setTab] = useState<Tab>('dashboard')
  const [focusApprovalId, setFocusApprovalId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState({ phase: 'loading' })
    try {
      const migration = await window.clad.getMigrationStatus()
      if (migration.needed) {
        setState({
          phase: 'migration-needed',
          plaidDbPath: migration.plaidDbPath,
          reason: migration.reason ?? 'cli-store-detected',
        })
        return
      }
      const config = await window.clad.getConfig()
      setState({ phase: 'ready', config })
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // D2.1: clicking the native OS notification for a newly-appeared pending
  // approval (main process already focused the window by the time this
  // fires — see `notifyNewApproval` in `main/index.ts`) switches to the
  // Approvals tab and tells `ApprovalsInbox` which item to scroll-to/highlight.
  useEffect(() => {
    const unsubscribe = window.clad.onApprovalFocusRequested(({ id }) => {
      setTab('approvals')
      setFocusApprovalId(id)
    })
    return unsubscribe
  }, [])

  return (
    <main style={s.page}>
      <h1>Clad</h1>
      {state.phase === 'loading' && <p>Loading…</p>}
      {state.phase === 'error' && <p style={s.errorText}>Error: {state.message}</p>}
      {state.phase === 'migration-needed' && (
        <MigrationPrompt plaidDbPath={state.plaidDbPath} reason={state.reason} onResolved={load} />
      )}
      {state.phase === 'ready' && (
        <>
          <nav style={s.nav}>
            <button
              type="button"
              style={tab === 'dashboard' ? s.navButtonActive : s.navButton}
              onClick={() => setTab('dashboard')}
            >
              Dashboard
            </button>
            <button
              type="button"
              style={tab === 'approvals' ? s.navButtonActive : s.navButton}
              onClick={() => setTab('approvals')}
            >
              Approvals
            </button>
            <button
              type="button"
              style={tab === 'audit' ? s.navButtonActive : s.navButton}
              onClick={() => setTab('audit')}
            >
              Audit log
            </button>
            <button
              type="button"
              style={tab === 'policy' ? s.navButtonActive : s.navButton}
              onClick={() => setTab('policy')}
            >
              Policy
            </button>
            <button
              type="button"
              style={tab === 'settings' ? s.navButtonActive : s.navButton}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
          </nav>

          {tab === 'dashboard' && <Dashboard />}
          {tab === 'approvals' && <ApprovalsInbox focusApprovalId={focusApprovalId} />}
          {tab === 'audit' && <AuditLogViewer />}
          {tab === 'policy' && <PolicyEditor />}
          {tab === 'settings' && (
            <>
              <ServerStatusPanel />
              <ConnectClaudeDesktop />
              <SettingsForm
                config={state.config}
                onConfigChange={(next) => setState({ phase: 'ready', config: next })}
              />
            </>
          )}
        </>
      )}
    </main>
  )
}
