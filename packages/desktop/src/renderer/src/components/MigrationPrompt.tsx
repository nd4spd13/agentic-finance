import { useState } from 'react'
import type { MigrationReason } from '../../../shared/ipc.js'
import * as s from '../styles.js'

const COPY: Record<MigrationReason, { heading: string; body: JSX.Element }> = {
  'cli-store-detected': {
    heading: 'Existing Clad data found',
    body: (
      <p>
        To use it from this app, enter the passphrase you set when you ran{' '}
        <code>clad connect</code>. It will be stored securely (via your OS keychain) so you won&apos;t need to
        enter it again.
      </p>
    ),
  },
  'passphrase-undecryptable': {
    heading: "Stored passphrase can't be unlocked",
    body: (
      <p>
        Clad previously saved an encrypted passphrase for the bank-connection store below, but this OS
        keychain can no longer open it — this usually happens after re-installing or updating an unsigned
        build (Keychain access is tied to the app&apos;s code-signing identity, which changes on every
        unsigned rebuild). If you know the passphrase (e.g. from the Clad CLI), enter it below to re-link the
        existing store.
      </p>
    ),
  },
}

/**
 * One-time prompt shown either when the desktop app detects a pre-existing
 * CLI-managed token store (`~/.clad/plaid.sqlite` by default) it hasn't
 * resolved passphrase custody for yet, or when it HAD resolved custody but
 * the sealed passphrase can no longer be decrypted (D1 manual QA finding 3
 * — see `passphrase.ts`'s `PassphraseSource` doc: typically a packaged,
 * differently code-signed build unable to open ciphertext a dev build
 * wrote). Both cases share the exact same recovery mechanics — enter a known
 * passphrase, or start fresh — so `reason` only changes the explanatory
 * copy, not the form/actions below. See `passphrase.ts`'s module doc for the
 * migration decision (wrap the CLI passphrase in safeStorage, don't
 * re-encrypt the database) and desktop-app.md's S0.3 "Spike results".
 *
 * Never echoes the entered passphrase back anywhere — it's sent once, over
 * IPC, to `migration:submitCliPassphrase`, and the main process reports
 * only success/failure.
 */
export default function MigrationPrompt({
  plaidDbPath,
  reason,
  onResolved,
}: {
  plaidDbPath: string
  reason: MigrationReason
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

  const copy = COPY[reason]

  return (
    <div style={s.card}>
      <h2 style={{ marginTop: 0 }}>{copy.heading}</h2>
      <p>
        {reason === 'cli-store-detected'
          ? 'A bank connection store created by the Clad CLI already exists at:'
          : 'The bank-connection store this passphrase unlocks is at:'}
      </p>
      <div style={s.pathList}>{plaidDbPath}</div>
      {copy.body}
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
            {reason === 'cli-store-detected'
              ? "This creates a new, separate connection store for the desktop app. Your existing CLI-linked accounts stay exactly where they are and remain usable from the CLI — you'll just need to reconnect your bank accounts from this app."
              : "This seals a brand-new passphrase and starts a new, separate connection store. The old store's data stays on disk untouched but can no longer be decrypted (the passphrase that protected it is unrecoverable) — you'll need to reconnect your bank accounts from this app."}
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
