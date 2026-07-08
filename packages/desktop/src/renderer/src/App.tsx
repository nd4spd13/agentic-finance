import { useEffect, useState } from 'react'
import type { SpikeStatus } from '../../shared/ipc.js'

/**
 * Spike S0 scaffold UI: shows the display-safe results of the three
 * main-process spikes (S0.2/S0.3/S0.4), fetched over the typed IPC contract.
 * No secret material is ever requested or rendered here — see
 * `src/shared/ipc.ts` for the contract and `src/main/index.ts` for what
 * actually runs the checks.
 */
export default function App(): JSX.Element {
  const [status, setStatus] = useState<SpikeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.clad
      .getSpikeStatus()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', color: '#1a1a1a' }}>
      <h1>Clad — desktop spike (S0)</h1>
      <p>Main-process spike results, delivered over the typed IPC contract.</p>
      {error && <p style={{ color: 'crimson' }}>Error: {error}</p>}
      {!status && !error && <p>Loading…</p>}
      {status && (
        <pre
          style={{
            background: '#f4f4f4',
            padding: '1rem',
            borderRadius: 8,
            overflowX: 'auto',
          }}
        >
          {JSON.stringify(status, null, 2)}
        </pre>
      )}
    </main>
  )
}
