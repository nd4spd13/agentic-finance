import { useEffect, useState } from 'react'
import type {
  ConnectProvidersStatus,
  LinkedItem,
  PlaidLinkFlowStatus,
  ProviderConnectionState,
  RemoveLinkedItemResult,
  SimpleFinConnectResult,
} from '../../../shared/ipc.js'
import * as s from '../styles.js'

const CONNECTION_LABEL: Record<ProviderConnectionState, string> = {
  connected: 'Connected',
  'not-connected': 'Not connected',
  unavailable: 'Unavailable (finish Settings/migration first)',
}

const CONNECTION_COLOR: Record<ProviderConnectionState, string> = {
  connected: '#1e7a34',
  'not-connected': '#666',
  unavailable: '#8a6d00',
}

/**
 * Lists a provider's linked items, each with a per-item Remove control that
 * requires an inline confirm click before it fires (disconnecting is
 * destructive — for Plaid it revokes the access token upstream). Only ever
 * renders the display-safe metadata the main process sends (institution name
 * + created date); a token/access URL never crosses IPC to begin with.
 *
 * `onRemove` is expected to resolve to a `RemoveLinkedItemResult` and to have
 * already refreshed the parent's item list / connection status by the time it
 * resolves (see `ConnectView`), so this component only has to surface the
 * result's own warning/error.
 */
function LinkedItemsSection({
  items,
  loadError,
  onRemove,
  removeNote,
}: {
  items: LinkedItem[] | null
  loadError: string | null
  onRemove: (itemId: string) => Promise<RemoveLinkedItemResult>
  removeNote: string
}): JSX.Element {
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionWarning, setActionWarning] = useState<string | null>(null)

  async function handleRemove(itemId: string): Promise<void> {
    setBusyId(itemId)
    setActionError(null)
    setActionWarning(null)
    try {
      const result = await onRemove(itemId)
      if (!result.ok) {
        setActionError(result.error ?? 'Removing the connection failed.')
      } else if (result.warning) {
        setActionWarning(result.warning)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
      setConfirmingId(null)
    }
  }

  return (
    <div style={{ marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.25rem', fontSize: 14 }}>Linked items</h3>
      {loadError && <p style={s.errorText}>Could not load linked items: {loadError}</p>}
      {!loadError && items === null && <p style={s.mutedText}>Loading…</p>}
      {!loadError && items !== null && items.length === 0 && (
        <p style={s.mutedText}>No linked items.</p>
      )}
      {!loadError &&
        items !== null &&
        items.map((item) => (
          <div key={item.itemId} style={s.listRow}>
            <span>
              <strong>{item.institutionName}</strong>{' '}
              <span style={s.mutedText}>· linked {new Date(item.createdAt).toLocaleDateString()}</span>
            </span>
            {confirmingId === item.itemId ? (
              <span>
                <button
                  type="button"
                  style={s.buttonDanger}
                  disabled={busyId === item.itemId}
                  onClick={() => handleRemove(item.itemId)}
                >
                  {busyId === item.itemId ? 'Removing…' : 'Confirm remove'}
                </button>
                <button
                  type="button"
                  style={s.buttonSecondary}
                  disabled={busyId === item.itemId}
                  onClick={() => setConfirmingId(null)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                style={s.buttonDanger}
                disabled={busyId !== null}
                onClick={() => {
                  setActionError(null)
                  setActionWarning(null)
                  setConfirmingId(item.itemId)
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      {!loadError && items !== null && items.length > 0 && <p style={s.mutedText}>{removeNote}</p>}
      {actionWarning && <p style={s.warnText}>{actionWarning}</p>}
      {actionError && <p style={s.errorText}>{actionError}</p>}
    </div>
  )
}

/**
 * D3.2 — the "Add connection" screen. One place to see every supported
 * provider's connection state and drive its connect flow:
 *  - Plaid: D3.1's in-app Link flow (system browser + loopback server,
 *    driven from the main process — see `plaid-link-flow.ts`). Can take
 *    minutes (the user is off in a browser); supports cancel.
 *  - SimpleFIN: SF6's paste-a-token flow. The setup token is one-time-use
 *    and flows to the main process only — the resulting access URL is never
 *    sent back here (see `SimpleFinConnectResult` in `shared/ipc.ts`).
 *
 * Under each provider card it also lists that provider's linked items with a
 * per-item Remove control (see `LinkedItemsSection` above and
 * `main/lib/connection-management.ts`) — the only way to disconnect a linked
 * item for either provider.
 *
 * Rendered as its own top-level tab (not a Settings subsection) — see
 * `App.tsx`'s doc comment for why: connecting a bank is a first-class,
 * occasional user action with real in-progress/success/error states of its
 * own, not a form field alongside the provider/environment selects.
 */
export default function ConnectView(): JSX.Element {
  const [status, setStatus] = useState<ConnectProvidersStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [linkStatus, setLinkStatus] = useState<PlaidLinkFlowStatus>({ state: 'idle' })
  const [cancelBusy, setCancelBusy] = useState(false)

  const [setupToken, setSetupToken] = useState('')
  const [simplefinBusy, setSimplefinBusy] = useState(false)
  const [simplefinResult, setSimplefinResult] = useState<SimpleFinConnectResult | null>(null)

  const [plaidItems, setPlaidItems] = useState<LinkedItem[] | null>(null)
  const [plaidItemsError, setPlaidItemsError] = useState<string | null>(null)
  const [simplefinItems, setSimplefinItems] = useState<LinkedItem[] | null>(null)
  const [simplefinItemsError, setSimplefinItemsError] = useState<string | null>(null)

  async function reloadProvidersStatus(): Promise<void> {
    try {
      setStatus(await window.clad.getConnectProvidersStatus())
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  async function reloadPlaidItems(): Promise<void> {
    try {
      setPlaidItems(await window.clad.listPlaidItems())
      setPlaidItemsError(null)
    } catch (err) {
      setPlaidItemsError(err instanceof Error ? err.message : String(err))
    }
  }

  async function reloadSimpleFinItems(): Promise<void> {
    try {
      setSimplefinItems(await window.clad.listSimpleFinItems())
      setSimplefinItemsError(null)
    } catch (err) {
      setSimplefinItemsError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    let cancelled = false
    void reloadProvidersStatus()
    void reloadPlaidItems()
    void reloadSimpleFinItems()
    window.clad.getPlaidLinkStatus().then((s) => {
      if (!cancelled) setLinkStatus(s)
    })
    const unsubscribe = window.clad.onPlaidLinkStatusChanged((s) => {
      setLinkStatus(s)
      if (s.state === 'success' || s.state === 'error') {
        void reloadProvidersStatus()
        void reloadPlaidItems()
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Deliberately no busy latch here: the `startPlaidLink` invoke doesn't
  // resolve until the whole Link flow settles (success/error/timeout) —
  // potentially minutes later, while the user is off in their browser. The
  // UI's pending/terminal states arrive within milliseconds through the
  // `onPlaidLinkStatusChanged` subscription above, and overlapping starts are
  // already guarded main-side (`PlaidLinkFlowManager.start` returns the
  // in-flight status instead of starting a second flow). Latching a busy flag
  // across this await is exactly the bug this replaced: it kept the Cancel
  // button disabled for the entire flow. The resolved value is only a final
  // re-sync — after a cancel it's the manager's *current* status, so it never
  // resurrects the abandoned flow's state.
  async function handleStartPlaidLink(sandboxAuto?: boolean): Promise<void> {
    const next = await window.clad.startPlaidLink(sandboxAuto ? { sandboxAuto } : undefined)
    setLinkStatus(next)
  }

  async function handleCancelPlaidLink(): Promise<void> {
    setCancelBusy(true)
    try {
      setLinkStatus(await window.clad.cancelPlaidLink())
    } finally {
      setCancelBusy(false)
    }
  }

  async function handleRemovePlaidItem(itemId: string): Promise<RemoveLinkedItemResult> {
    const result = await window.clad.removePlaidItem(itemId)
    // Refresh the list + connection status regardless of the outcome — even a
    // warning-carrying success has already deleted the item locally.
    await reloadPlaidItems()
    await reloadProvidersStatus()
    return result
  }

  async function handleRemoveSimpleFinItem(itemId: string): Promise<RemoveLinkedItemResult> {
    const result = await window.clad.removeSimpleFinItem(itemId)
    await reloadSimpleFinItems()
    await reloadProvidersStatus()
    return result
  }

  async function handleSimpleFinConnect(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSimplefinBusy(true)
    setSimplefinResult(null)
    try {
      const result = await window.clad.connectSimpleFin(setupToken)
      setSimplefinResult(result)
      // The setup token is one-time-use and now consumed either way (claimed,
      // or already invalid) — never leave it sitting in the field.
      setSetupToken('')
      if (result.ok) {
        await reloadProvidersStatus()
        await reloadSimpleFinItems()
      }
    } finally {
      setSimplefinBusy(false)
    }
  }

  return (
    <>
      {loadError && <p style={s.errorText}>Error loading connection status: {loadError}</p>}

      <div style={s.card}>
        <h2 style={{ marginTop: 0 }}>Plaid</h2>
        {!status ? (
          <p style={s.mutedText}>Loading…</p>
        ) : (
          <>
            <p>
              <strong style={{ color: CONNECTION_COLOR[status.plaidConnection] }}>
                ● {CONNECTION_LABEL[status.plaidConnection]}
              </strong>
            </p>
            {/* D3.3: `status.plaidEnv` is the EFFECTIVE env (already normalized
                to 'production' in a packaged build) — a new "Connect a bank"
                click below lands in exactly this env's own token store, never
                the other one's. See `ConnectProvidersStatus.plaidEnv` in
                shared/ipc.ts. */}
            <p style={s.mutedText}>
              A new connection links into: <strong>{status.plaidEnv === 'production' ? 'Production' : 'Sandbox'}</strong>
            </p>
            {!status.plaidCredentialsConfigured && (
              <p style={s.warnText}>
                Add your Plaid Client ID/Secret in Settings before connecting a bank.
              </p>
            )}

            {linkStatus.state === 'pending' && (
              <>
                <p style={s.mutedText}>
                  Waiting for Plaid Link to finish in your browser… this can take a few minutes.
                </p>
                <button type="button" style={s.buttonSecondary} disabled={cancelBusy} onClick={handleCancelPlaidLink}>
                  Cancel
                </button>
              </>
            )}

            {linkStatus.state === 'success' && (
              <>
                <p style={s.successText}>
                  Connected: {linkStatus.institutionName}
                  {linkStatus.accounts && linkStatus.accounts.length > 0 && (
                    <>
                      {' '}
                      (
                      {linkStatus.accounts
                        .map((a) => `${a.name}${a.mask ? ` ••••${a.mask}` : ''}`)
                        .join(', ')}
                      )
                    </>
                  )}
                </p>
                <button
                  type="button"
                  style={s.buttonSecondary}
                  disabled={cancelBusy}
                  onClick={handleCancelPlaidLink}
                >
                  Dismiss
                </button>
              </>
            )}

            {linkStatus.state === 'error' && (
              <>
                <p style={s.errorText}>{linkStatus.error}</p>
                <button type="button" style={s.buttonSecondary} disabled={cancelBusy} onClick={handleCancelPlaidLink}>
                  Dismiss
                </button>
              </>
            )}

            {(linkStatus.state === 'idle') && (
              <>
                <button
                  type="button"
                  style={s.button}
                  disabled={!status.plaidCredentialsConfigured}
                  onClick={() => handleStartPlaidLink()}
                >
                  Connect a bank
                </button>
                {status.sandboxAutoAvailable && (
                  <button
                    type="button"
                    style={s.buttonSecondary}
                    disabled={!status.plaidCredentialsConfigured}
                    onClick={() => handleStartPlaidLink(true)}
                  >
                    Sandbox auto-connect (dev only, no browser)
                  </button>
                )}
              </>
            )}

            {status.plaidConnection !== 'unavailable' && (
              <LinkedItemsSection
                items={plaidItems}
                loadError={plaidItemsError}
                onRemove={handleRemovePlaidItem}
                removeNote="Removing a connection revokes its access token with Plaid (when your credentials are available) and deletes it from this device."
              />
            )}
          </>
        )}
      </div>

      <div style={s.card}>
        <h2 style={{ marginTop: 0 }}>SimpleFIN</h2>
        {!status ? (
          <p style={s.mutedText}>Loading…</p>
        ) : (
          <>
            <p>
              <strong style={{ color: CONNECTION_COLOR[status.simplefinConnection] }}>
                ● {CONNECTION_LABEL[status.simplefinConnection]}
              </strong>
            </p>
            <p style={s.mutedText}>
              Generate a setup token at{' '}
              <a href="https://bridge.simplefin.org/simplefin/create">bridge.simplefin.org</a> (a free demo
              token is available at{' '}
              <a href="https://beta-bridge.simplefin.org/info/developers">beta-bridge.simplefin.org</a>), then
              paste it below. It is one-time use — pasting it here consumes it.
            </p>
            <form onSubmit={handleSimpleFinConnect}>
              <label style={s.label} htmlFor="simplefin-setup-token">
                Setup token
              </label>
              <input
                id="simplefin-setup-token"
                type="text"
                style={s.input}
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                disabled={simplefinBusy}
                autoComplete="off"
              />
              <button type="submit" style={s.button} disabled={simplefinBusy || !setupToken.trim()}>
                Connect
              </button>
            </form>
            {simplefinResult && simplefinResult.ok && (
              <>
                <p style={s.successText}>
                  Connected: SimpleFIN Bridge
                  {simplefinResult.accounts && simplefinResult.accounts.length > 0 && (
                    <> ({simplefinResult.accounts.map((a) => a.name).join(', ')})</>
                  )}
                </p>
                {simplefinResult.warning && <p style={s.warnText}>{simplefinResult.warning}</p>}
              </>
            )}
            {simplefinResult && !simplefinResult.ok && <p style={s.errorText}>{simplefinResult.error}</p>}

            {status.simplefinConnection !== 'unavailable' && (
              <LinkedItemsSection
                items={simplefinItems}
                loadError={simplefinItemsError}
                onRemove={handleRemoveSimpleFinItem}
                removeNote="Removing a connection deletes it from this device. SimpleFIN has no revoke API — to fully revoke a token, do so on the SimpleFIN Bridge website."
              />
            )}
          </>
        )}
      </div>
    </>
  )
}
