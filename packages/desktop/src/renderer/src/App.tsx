import { useCallback, useEffect, useState } from 'react'
import type { DisplayConfig } from '../../shared/ipc.js'
import MigrationPrompt from './components/MigrationPrompt.js'
import SettingsForm from './components/SettingsForm.js'
import * as s from './styles.js'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'migration-needed'; plaidDbPath: string }
  | { phase: 'ready'; config: DisplayConfig }

/**
 * D1 shell: settings screen (paths, provider/Plaid env, Plaid credentials)
 * plus the one-time CLI-migration prompt when applicable. Server status
 * (D1.2) and the Connect-to-Claude-Desktop action (D1.4) are added to this
 * screen in later commits — the full product UI (approvals inbox,
 * dashboard, policy editor) is Phase D2, out of scope here.
 */
export default function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  const load = useCallback(async () => {
    setState({ phase: 'loading' })
    try {
      const migration = await window.clad.getMigrationStatus()
      if (migration.needed) {
        setState({ phase: 'migration-needed', plaidDbPath: migration.plaidDbPath })
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
        <MigrationPrompt plaidDbPath={state.plaidDbPath} onResolved={load} />
      )}
      {state.phase === 'ready' && (
        <SettingsForm
          config={state.config}
          onConfigChange={(next) => setState({ phase: 'ready', config: next })}
        />
      )}
    </main>
  )
}
