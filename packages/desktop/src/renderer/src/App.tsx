import { useCallback, useEffect, useState } from 'react'
import type { DisplayConfig, MigrationReason } from '../../shared/ipc.js'
import MigrationPrompt from './components/MigrationPrompt.js'
import SettingsForm from './components/SettingsForm.js'
import ServerStatusPanel from './components/ServerStatusPanel.js'
import ConnectClaudeDesktop from './components/ConnectClaudeDesktop.js'
import Dashboard from './components/Dashboard.js'
import * as s from './styles.js'

// D2 nav (introduced by D2.3): a minimal tab switcher for the "ready" phase
// below. Kept intentionally tiny (a union + one useState) so later D2 work
// (policy editor, approvals inbox, audit viewer) only needs to extend this
// union and the two spots that reference it — nothing here restructures the
// existing Settings content, which keeps rendering exactly as it did in D1,
// just under its own tab now.
type Tab = 'dashboard' | 'settings'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'migration-needed'; plaidDbPath: string; reason: MigrationReason }
  | { phase: 'ready'; config: DisplayConfig }

/**
 * D1 shell: settings screen (paths, provider/Plaid env, Plaid credentials,
 * close-to-tray), the one-time CLI-migration prompt when applicable, MCP
 * server status/controls (D1.2), and the Connect-to-Claude-Desktop action
 * (D1.4). Tray/menu-bar presence (D1.3) lives entirely in the main process
 * (`src/main/index.ts`) — nothing to render here. The full product UI
 * (approvals inbox, dashboard, policy editor) is Phase D2, out of scope
 * here.
 */
export default function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [tab, setTab] = useState<Tab>('dashboard')

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
              style={tab === 'settings' ? s.navButtonActive : s.navButton}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
          </nav>

          {tab === 'dashboard' && <Dashboard />}
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
