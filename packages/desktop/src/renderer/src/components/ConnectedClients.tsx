import { useEffect, useState } from 'react'
import type { ConnectedClient, RevokeClientResult } from '../../../shared/ipc.js'
import * as s from '../styles.js'

/** Friendly labels for the scope strings WS2 mints from policy — falls back to the raw scope string for anything not in this map, so an unrecognized scope still renders instead of disappearing. */
const SCOPE_LABELS: Record<string, string> = {
  'accounts:read': 'Read balances',
  'transactions:read': 'Read transactions',
  'actions:request': 'Request actions',
}

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope
}

function formatLastUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return 'Never used'
  return `Last used ${new Date(lastUsedAt).toLocaleString()}`
}

/**
 * "Connected clients" section on the Connect screen (D5.3 WS4 S1-S2) — lists
 * every OAuth grant issued to an MCP client (Claude Desktop, Claude Code, …)
 * through this app's supervised MCP child, with a per-row Revoke control
 * behind a confirm. Styled after `ConnectView.tsx`'s `LinkedItemsSection`
 * (list + inline confirm/cancel) and `ApprovalsInbox.tsx` (per-row action).
 *
 * Only ever renders the display-safe `ConnectedClient` metadata the main
 * process sends — never a token, client secret, or authorization code (see
 * `main/lib/connected-clients.ts`). The reported client name is labeled as
 * self-reported (DCR clients choose it themselves — untrusted); the bound
 * `profileId` is the field a human should actually trust, since it is
 * server-chosen at consent and immutable thereafter (WS4 §7 "Client identity
 * display").
 *
 * Revoked grants stay in the list (display-only, no Revoke control) rather
 * than disappearing — `main/lib/connected-clients.ts`'s `listConnectedClients`
 * deliberately does not filter them out, leaving "how/whether to show them"
 * to this component.
 *
 * Subscribes to `onConnectedClientsChanged` for live updates after a revoke
 * (the main process pushes the refreshed list once the revoke lands) — same
 * subscribe/unsubscribe shape as `onMcpStatusChanged`/`onPlaidLinkStatusChanged`
 * elsewhere in this app.
 *
 * `unavailable` is passed in by the parent (`ConnectView.tsx`), reusing the
 * SAME `ConnectProvidersStatus.plaidConnection`/`simplefinConnection`
 * `'unavailable'` signal the Plaid/SimpleFIN cards already show — the grant
 * store shares their custody-resolved passphrase (config.ts's `grant_db` doc
 * comment), so a fresh IPC round-trip / new error surface isn't needed to
 * know the store is unavailable (WS4 §4.3).
 */
export default function ConnectedClients({ unavailable }: { unavailable: boolean }): JSX.Element {
  const [clients, setClients] = useState<ConnectedClient[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function reload(): Promise<void> {
    try {
      setClients(await window.clad.listConnectedClients())
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    // The grant store shares the token-store passphrase with Plaid/SimpleFIN
    // — when the parent reports it unavailable there is nothing listable yet
    // (same reasoning as `listConnectedClients`'s own passphrase-unresolved
    // short-circuit), so skip the load entirely rather than surface a
    // transient error.
    if (unavailable) return
    void reload()
    const unsubscribe = window.clad.onConnectedClientsChanged((updated) => {
      setClients(updated)
    })
    return unsubscribe
  }, [unavailable])

  async function handleRevoke(grantId: string): Promise<void> {
    setBusyId(grantId)
    setActionError(null)
    try {
      const result: RevokeClientResult = await window.clad.revokeConnectedClient(grantId)
      if (!result.ok) {
        setActionError(result.error ?? 'Revoking access failed.')
      }
      // The main process also pushes `onConnectedClientsChanged` on success;
      // reload defensively too so a FAILED revoke's confirm state still
      // clears against a consistent list.
      await reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
      setConfirmingId(null)
    }
  }

  return (
    <div style={s.card}>
      <h2 style={{ marginTop: 0 }}>Connected clients</h2>
      <p style={s.mutedText}>
        MCP clients (like Claude Desktop) approved to connect, and which agent profile each was
        approved for. Revoking a client ends its access immediately.
      </p>

      {unavailable && <p style={s.warnText}>Unavailable (finish Settings/migration first)</p>}
      {!unavailable && loadError && (
        <p style={s.errorText}>Could not load connected clients: {loadError}</p>
      )}
      {!unavailable && !loadError && clients === null && <p style={s.mutedText}>Loading…</p>}
      {!unavailable && !loadError && clients !== null && clients.length === 0 && (
        <p style={s.mutedText}>No connected clients yet.</p>
      )}
      {!unavailable &&
        !loadError &&
        clients !== null &&
        clients.map((client) => (
          <div key={client.grantId} style={{ padding: '0.5rem 0', borderBottom: '1px solid #e5e5e5' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 14,
              }}
            >
              <span>
                {client.clientName ? (
                  <>
                    <strong>{client.clientName}</strong> <span style={s.mutedText}>(self-reported)</span>
                  </>
                ) : (
                  <span style={s.mutedText}>Unnamed client</span>
                )}
                {' · profile '}
                <strong>{client.profileId}</strong>
                {client.revoked && <span style={{ ...s.mutedText, marginLeft: '0.4rem' }}>· Revoked</span>}
              </span>
              {!client.revoked &&
                (confirmingId === client.grantId ? (
                  <span>
                    <button
                      type="button"
                      style={s.buttonDanger}
                      disabled={busyId === client.grantId}
                      onClick={() => handleRevoke(client.grantId)}
                    >
                      {busyId === client.grantId ? 'Revoking…' : 'Confirm revoke'}
                    </button>
                    <button
                      type="button"
                      style={s.buttonSecondary}
                      disabled={busyId === client.grantId}
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
                      setConfirmingId(client.grantId)
                    }}
                  >
                    Revoke
                  </button>
                ))}
            </div>
            {confirmingId === client.grantId && !client.revoked && (
              <p style={{ ...s.warnText, margin: '0.25rem 0 0' }}>
                {client.clientName ?? 'This client'} will lose access immediately.
              </p>
            )}
            <div style={{ margin: '0.35rem 0 0', display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
              {client.scopes.map((scope) => (
                <span key={scope} style={s.tag}>
                  {scopeLabel(scope)}
                </span>
              ))}
              {client.dpopBound && <span style={s.tag}>DPoP-bound</span>}
            </div>
            <p style={{ ...s.mutedText, margin: '0.35rem 0 0' }}>
              Connected {new Date(client.createdAt).toLocaleDateString()} · {formatLastUsed(client.lastUsedAt)}
            </p>
          </div>
        ))}
      {actionError && <p style={s.errorText}>{actionError}</p>}
    </div>
  )
}
