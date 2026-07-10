import { useState } from 'react'
import type { CladProvider, DisplayConfig, PlaidEnvName } from '../../../shared/ipc.js'
import * as s from '../styles.js'

/**
 * D1.1 settings screen: display-only config paths, provider + Plaid
 * environment selection, and Plaid Client ID/Secret entry (safeStorage-only
 * — see `plaid-secrets.ts`). Renderer UI in D1 is intentionally minimal;
 * the approvals inbox / audit viewer / dashboard / policy editor are D2.
 */
export default function SettingsForm({
  config,
  onConfigChange,
}: {
  config: DisplayConfig
  onConfigChange: (next: DisplayConfig) => void
}): JSX.Element {
  const [provider, setProvider] = useState<CladProvider>(config.provider)
  const [plaidEnv, setPlaidEnv] = useState<PlaidEnvName>(config.plaidEnv)
  const [savingProvider, setSavingProvider] = useState(false)
  const [providerMessage, setProviderMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const [closeToTray, setCloseToTray] = useState(config.closeToTray)
  const [closeToTrayMessage, setCloseToTrayMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [savingCreds, setSavingCreds] = useState(false)
  const [credsMessage, setCredsMessage] = useState<{ ok: boolean; text: string } | null>(null)

  async function handleSaveProvider(): Promise<void> {
    setSavingProvider(true)
    setProviderMessage(null)
    try {
      // Packaged builds never render the environment <select> below, so
      // `plaidEnv` state here is always already 'production' in that case —
      // this call can't accidentally request 'sandbox'. The main process
      // still rejects it defensively either way (`configSetProviderAndEnv`
      // in `main/index.ts`).
      const result = await window.clad.setProviderAndEnv({ provider, plaidEnv })
      if (result.ok) {
        setProviderMessage({ ok: true, text: 'Saved.' })
        // Re-fetch the full config (rather than hand-merging provider/plaidEnv
        // into the existing one) so the Plaid credentials card below —
        // labeled and scoped to `config.plaidEnv` — immediately reflects the
        // newly-active env's own saved status, not the previous env's.
        const fresh = await window.clad.getConfig()
        setPlaidEnv(fresh.plaidEnv)
        // Stale unsaved credential input was typed against whichever env's
        // card was showing before this save — clear it rather than let it
        // carry over and get saved into the new env's slot by mistake.
        setClientId('')
        setSecret('')
        setCredsMessage(null)
        onConfigChange(fresh)
      } else {
        setProviderMessage({ ok: false, text: result.error ?? 'Failed to save.' })
      }
    } finally {
      setSavingProvider(false)
    }
  }

  /**
   * Applies immediately (no separate Save button) — a checkbox toggle is a
   * cheap, instantly-reversible setting, unlike provider/Plaid changes which
   * take an explicit confirming action. Reverts the checkbox on failure
   * (e.g. disk write error) rather than leaving the UI showing a state that
   * was never actually persisted.
   */
  async function handleToggleCloseToTray(checked: boolean): Promise<void> {
    setCloseToTray(checked)
    setCloseToTrayMessage(null)
    const result = await window.clad.setCloseToTray({ closeToTray: checked })
    if (result.ok) {
      onConfigChange({ ...config, closeToTray: checked })
    } else {
      setCloseToTray(!checked)
      setCloseToTrayMessage({ ok: false, text: result.error ?? 'Failed to save.' })
    }
  }

  async function handleSaveCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSavingCreds(true)
    setCredsMessage(null)
    try {
      const result = await window.clad.setPlaidCredentials({ clientId, secret })
      if (result.ok) {
        setCredsMessage({ ok: true, text: 'Plaid credentials saved.' })
        setClientId('')
        setSecret('')
        onConfigChange({ ...config, plaidCredentialsStatus: 'set' })
      } else {
        setCredsMessage({ ok: false, text: result.error ?? 'Failed to save credentials.' })
      }
    } finally {
      setSavingCreds(false)
    }
  }

  async function handleClearCredentials(): Promise<void> {
    setSavingCreds(true)
    setCredsMessage(null)
    try {
      const result = await window.clad.clearPlaidCredentials()
      if (result.ok) {
        setCredsMessage({ ok: true, text: 'Plaid credentials cleared.' })
        onConfigChange({ ...config, plaidCredentialsStatus: 'unset' })
      } else {
        setCredsMessage({ ok: false, text: result.error ?? 'Failed to clear credentials.' })
      }
    } finally {
      setSavingCreds(false)
    }
  }

  return (
    <>
      <div style={s.card}>
        <h2 style={{ marginTop: 0 }}>Data locations</h2>
        <p style={s.mutedText}>
          Shared with the Clad CLI — both read the same files, so agent
          activity is visible from either.
        </p>
        <dl style={s.pathList}>
          <div>
            <strong>Config dir:</strong> {config.configDir}
          </div>
          <div>
            <strong>Policy:</strong> {config.policyPath}
          </div>
          <div>
            <strong>Audit log:</strong> {config.auditDbPath}
          </div>
          <div>
            <strong>Approvals:</strong> {config.approvalDbPath}
          </div>
          <div>
            <strong>Plaid token store:</strong> {config.plaidDbPath}
          </div>
        </dl>
      </div>

      <div style={s.card}>
        <h2 style={{ marginTop: 0 }}>Window behavior</h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 400, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={closeToTray}
            onChange={(e) => handleToggleCloseToTray(e.target.checked)}
          />
          Keep Clad running in the menu bar when the window is closed
        </label>
        {closeToTrayMessage && (
          <p style={closeToTrayMessage.ok ? s.successText : s.errorText}>{closeToTrayMessage.text}</p>
        )}
      </div>

      <div style={s.card}>
        <h2 style={{ marginTop: 0 }}>Data provider</h2>
        <label style={s.label} htmlFor="provider">
          Provider
        </label>
        <select
          id="provider"
          style={s.select}
          value={provider}
          onChange={(e) => setProvider(e.target.value as CladProvider)}
        >
          <option value="dummy">Demo data (no bank connection)</option>
          <option value="plaid">Plaid</option>
        </select>

        {config.isPackaged ? (
          <p style={s.mutedText}>
            Plaid environment: <strong>Production</strong> — packaged builds are production-only and
            can&apos;t switch to Sandbox.
          </p>
        ) : (
          <>
            <label style={s.label} htmlFor="plaid-env">
              Plaid environment
            </label>
            <select
              id="plaid-env"
              style={s.select}
              value={plaidEnv}
              onChange={(e) => setPlaidEnv(e.target.value as PlaidEnvName)}
            >
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </select>
          </>
        )}

        <button type="button" style={s.button} onClick={handleSaveProvider} disabled={savingProvider}>
          Save
        </button>
        {providerMessage && (
          <p style={providerMessage.ok ? s.successText : s.errorText}>{providerMessage.text}</p>
        )}
      </div>

      <div style={s.card}>
        <h2 style={{ marginTop: 0 }}>
          Plaid credentials{' '}
          <span style={{ fontWeight: 400, fontSize: '0.75em' }}>
            ({config.plaidEnv === 'production' ? 'Production' : 'Sandbox'})
          </span>
        </h2>
        {/* D3.3: these credentials are scoped to `config.plaidEnv` — see
            `getActivePlaidSecrets()` in main/index.ts. Switching the env
            above and saving shows/edits that env's own slot, never the
            other one's. */}
        <p style={s.mutedText}>
          Bring your own Plaid <code>CLIENT_ID</code> / <code>SECRET</code> (
          {/* Cross-origin navigation is intercepted by the main process's
              will-navigate handler and reopened in the system browser —
              never in-app. See src/main/index.ts / security checklist #4. */}
          <a href="https://dashboard.plaid.com/team/keys">dashboard.plaid.com</a>
          ). Stored via your OS keychain — never written to a plaintext
          config file.
        </p>
        {config.plaidCredentialsStatus === 'undecryptable' ? (
          <p style={s.warnText}>
            Stored credentials can&apos;t be unlocked — this usually happens after app updates on unsigned
            builds. Please re-enter them below.
          </p>
        ) : config.plaidCredentialsStatus === 'set' ? (
          <p style={s.successText}>
            Plaid credentials are saved. Enter new values to replace them, or clear them below.
          </p>
        ) : (
          <p style={s.mutedText}>No Plaid credentials saved yet.</p>
        )}
        <form onSubmit={handleSaveCredentials}>
          <label style={s.label} htmlFor="plaid-client-id">
            Client ID
          </label>
          <input
            id="plaid-client-id"
            type="text"
            style={s.input}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            disabled={savingCreds}
            autoComplete="off"
            placeholder={config.plaidCredentialsStatus === 'set' ? 'saved — enter to replace' : undefined}
          />
          <label style={s.label} htmlFor="plaid-secret">
            Secret
          </label>
          <input
            id="plaid-secret"
            type="password"
            style={s.input}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            disabled={savingCreds}
            autoComplete="off"
            placeholder={config.plaidCredentialsStatus === 'set' ? 'saved — enter to replace' : undefined}
          />
          {credsMessage && <p style={credsMessage.ok ? s.successText : s.errorText}>{credsMessage.text}</p>}
          <button type="submit" style={s.button} disabled={savingCreds || !clientId || !secret}>
            Save credentials
          </button>
          {config.plaidCredentialsStatus !== 'unset' && (
            <button type="button" style={s.buttonDanger} disabled={savingCreds} onClick={handleClearCredentials}>
              Clear
            </button>
          )}
        </form>
      </div>
    </>
  )
}
