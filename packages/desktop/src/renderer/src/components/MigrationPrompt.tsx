import { useState } from 'react'
import * as s from '../styles.js'

/**
 * One-time prompt shown when the desktop app detects a pre-existing
 * CLI-managed token store (`~/.clad/plaid.sqlite` by default) that it
 * hasn't resolved passphrase custody for yet. See `passphrase.ts`'s module
 * doc for the migration decision (wrap the CLI passphrase in safeStorage,
 * don't re-encrypt the database) and desktop-app.md's S0.3 "Spike results".
 *
 * Never echoes the entered passphrase back anywhere — it's sent once, over
 * IPC, to `migration:submitCliPassphrase`, and the main process reports
 * only success/failure.
 */
export default function MigrationPrompt({
  plaidDbPath,
  onResolved,
}: {
  plaidDbPath: string
  onResolved: () => void
}): JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingFresh, setConfirmingFresh] = useState(false)

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!passphrase) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.clad.submitCliPassphrase(passphrase)
      if (result.ok) {
        onResolved()
      } else {
        setError(result.error ?? 'Could not unlock the existing token store.')
      }
    } finally {
      setSubmitting(false)
      setPassphrase('')
    }
  }

  async function handleStartFresh(): Promise<void> {
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.clad.startFreshTokenStore()
      if (result.ok) {
        onResolved()
      } else {
        setError(result.error ?? 'Could not start a fresh token store.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={s.card}>
      <h2 style={{ marginTop: 0 }}>Existing Clad data found</h2>
      <p>
        A bank connection store created by the Clad CLI already exists at:
      </p>
      <div style={s.pathList}>{plaidDbPath}</div>
      <p>
        To use it from this app, enter the passphrase you set when you ran{' '}
        <code>clad connect</code>. It will be stored securely (via your OS
        keychain) so you won&apos;t need to enter it again.
      </p>
      <form onSubmit={handleSubmit}>
        <label style={s.label} htmlFor="cli-passphrase">
          CLI token store passphrase
        </label>
        <input
          id="cli-passphrase"
          type="password"
          style={s.input}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          disabled={submitting}
          autoFocus
        />
        {error && <p style={s.errorText}>{error}</p>}
        <button type="submit" style={s.button} disabled={submitting || !passphrase}>
          Unlock
        </button>
      </form>

      <hr style={{ margin: '1.25rem 0', border: 'none', borderTop: '1px solid #ddd' }} />

      {!confirmingFresh ? (
        <button
          type="button"
          style={s.buttonSecondary}
          disabled={submitting}
          onClick={() => setConfirmingFresh(true)}
        >
          I don&apos;t remember it — start fresh instead
        </button>
      ) : (
        <div>
          <p style={s.mutedText}>
            This creates a new, separate connection store for the desktop app.
            Your existing CLI-linked accounts stay exactly where they are and
            remain usable from the CLI — you&apos;ll just need to reconnect
            your bank accounts from this app.
          </p>
          <button type="button" style={s.buttonDanger} disabled={submitting} onClick={handleStartFresh}>
            Yes, start fresh
          </button>
          <button type="button" style={s.buttonSecondary} disabled={submitting} onClick={() => setConfirmingFresh(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
