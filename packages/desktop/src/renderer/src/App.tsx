import { useCallback, useEffect, useState } from 'react'
import type { DisplayConfig, MigrationReason } from '../../shared/ipc.js'
import MigrationPrompt from './components/MigrationPrompt.js'
import SettingsForm from './components/SettingsForm.js'
import ServerStatusPanel from './components/ServerStatusPanel.js'
import ConnectClaudeDesktop from './components/ConnectClaudeDesktop.js'
import ApprovalsInbox from './components/ApprovalsInbox.js'
import * as s from './styles.js'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'migration-needed'; plaidDbPath: string; reason: MigrationReason }
  | { phase: 'ready'; config: DisplayConfig }

/** D2.1 nav tabs. 'settings' is the original D1 shell content, unchanged. */
type Tab = 'settings' | 'approvals'

/**
 * D1 shell: settings screen (paths, provider/Plaid env, Plaid credentials,
 * close-to-tray), the one-time CLI-migration prompt when applicable, MCP
 * server status/controls (D1.2), and the Connect-to-Claude-Desktop action
 * (D1.4). Tray/menu-bar presence (D1.3) lives entirely in the main process
 * (`src/main/index.ts`) — nothing to render here. D2.1 adds the approvals
 * inbox as a sibling tab alongside the original D1 settings content
 * (audit log viewer, dashboard, policy editor remain out of scope here).
 */
export default function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [tab, setTab] = useState<Tab>('settings')
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
          <nav style={s.navBar}>
            <button
              type="button"
              style={tab === 'settings' ? s.navButtonActive : s.navButton}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
            <button
              type="button"
              style={tab === 'approvals' ? s.navButtonActive : s.navButton}
              onClick={() => setTab('approvals')}
            >
              Approvals
            </button>
          </nav>
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
          {tab === 'approvals' && <ApprovalsInbox focusApprovalId={focusApprovalId} />}
        </>
      )}
    </main>
  )
}
