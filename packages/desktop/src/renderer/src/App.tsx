import { useCallback, useEffect, useState } from 'react'
import type { DisplayConfig, MigrationReason } from '../../shared/ipc.js'
import MigrationPrompt from './components/MigrationPrompt.js'
import SettingsForm from './components/SettingsForm.js'
import ServerStatusPanel from './components/ServerStatusPanel.js'
import ConnectClaudeDesktop from './components/ConnectClaudeDesktop.js'
import * as s from './styles.js'

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
          <ServerStatusPanel />
          <ConnectClaudeDesktop />
          <SettingsForm
            config={state.config}
            onConfigChange={(next) => setState({ phase: 'ready', config: next })}
          />
        </>
      )}
    </main>
  )
}
