import { useCallback, useEffect, useRef, useState } from 'react'
import type { DashboardSnapshot } from '../../../shared/ipc.js'
import * as s from '../styles.js'

/**
 * D2.3 dashboard: balances + recent transactions via the main process's
 * provider-agnostic adapter layer (`main/lib/dashboard-data.ts` +
 * `provider-factory.ts` — dummy or Plaid today, SimpleFIN slots in later
 * with no change here).
 *
 * RATE-LIMIT DISCIPLINE (desktop-app.md D2.3, critical — amended 2026-07-10,
 * see `dashboard-data.ts`'s module doc for the full amendment): mounting
 * this component reads the cache (`getDashboardSnapshot`) and MAY fire
 * exactly one automatic `refreshDashboard` call per mount — never more.
 * There is still no polling interval anywhere in this file, no
 * fetch-on-every-mount, and no auto-refresh while the provider isn't fully
 * configured. The auto-refresh effect below only fires once (guarded by
 * `autoRefreshAttempted`, which survives React StrictMode's dev-mode double
 * effect invoke) and only when the just-loaded snapshot reports
 * `lastRefreshed === null` (nothing fetched yet this session) and
 * `state === 'ready'`. A failed auto-refresh still marks the guard so it
 * never retries/loops — the "Refresh" button remains available to try
 * again manually. The `lastRefreshed` stamp is shown next to it so stale
 * data is never mistaken for live data.
 */
export default function Dashboard(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const autoRefreshAttempted = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await window.clad.getDashboardSnapshot())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      setSnapshot(await window.clad.refreshDashboard())
    } finally {
      setRefreshing(false)
    }
  }, [])

  // One-shot auto-refresh on launch (2026-07-10 owner-QA amendment — see
  // this component's doc comment above and dashboard-data.ts's module doc).
  // Runs after the initial `load()` resolves; a ref (not state) tracks
  // whether this session has already attempted it so re-renders — including
  // the one `handleRefresh` itself triggers — never fire it a second time.
  useEffect(() => {
    if (loading || !snapshot) return
    if (autoRefreshAttempted.current) return
    if (snapshot.lastRefreshed !== null || snapshot.state !== 'ready') return

    autoRefreshAttempted.current = true
    void handleRefresh()
  }, [loading, snapshot, handleRefresh])

  if (loading || !snapshot) {
    return (
      <div style={s.card}>
        <p style={s.mutedText}>Loading…</p>
      </div>
    )
  }

  return (
    <div>
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>Dashboard</h2>
            <p style={s.mutedText}>{formatLastRefreshed(snapshot.lastRefreshed)}</p>
          </div>
          <button type="button" style={s.button} disabled={refreshing} onClick={handleRefresh}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {snapshot.state === 'no-provider-configured' && (
          <p style={s.warnText}>
            {snapshot.error ?? 'The Plaid provider is selected but not fully set up.'} Open Settings to finish
            setup, or switch the provider to Demo data to explore the dashboard without one.
          </p>
        )}
        {snapshot.state === 'error' && (
          <p style={s.errorText}>
            Couldn&apos;t refresh: {snapshot.error}
            {snapshot.lastRefreshed && ' — showing the last data fetched successfully.'}
          </p>
        )}
      </div>

      <div style={s.card}>
        <h3 style={{ marginTop: 0 }}>Accounts</h3>
        {snapshot.accounts.length === 0 ? (
          <p style={s.mutedText}>
            {snapshot.state === 'no-provider-configured'
              ? 'Nothing to show yet.'
              : 'No data yet — click Refresh to load balances.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr style={s.tableHeaderRow}>
                  <th style={s.tableCell}>Name</th>
                  <th style={s.tableCell}>Institution</th>
                  <th style={s.tableCell}>Type</th>
                  <th style={s.tableCell}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.accounts.map((account) => (
                  <tr key={account.id} style={s.tableRow}>
                    <td style={s.tableCell}>
                      {account.name}
                      {account.mask && ` · •••• ${account.mask}`}
                      {account.stale && ' · stale'}
                    </td>
                    <td style={s.tableCell}>{account.institution ?? '—'}</td>
                    <td style={s.tableCell}>{account.type}</td>
                    <td style={{ ...s.tableCell, ...(account.balanceCurrent < 0 ? s.amountNegative : undefined) }}>
                      {formatCurrency(account.balanceCurrent, account.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={s.card}>
        <h3 style={{ marginTop: 0 }}>Recent transactions</h3>
        {snapshot.transactions.length === 0 ? (
          <p style={s.mutedText}>
            {snapshot.state === 'no-provider-configured'
              ? 'Nothing to show yet.'
              : 'No data yet — click Refresh to load transactions.'}
          </p>
        ) : (
          snapshot.transactions.map((txn) => (
            <div key={txn.id} style={s.listRow}>
              <div>
                <div>{txn.description}</div>
                <div style={s.mutedText}>
                  {txn.date}
                  {txn.pending && ' · pending'}
                  {txn.stale && ' · stale'}
                </div>
              </div>
              <div style={txn.amount < 0 ? s.amountNegative : s.amountPositive}>
                {formatCurrency(txn.amount, accountCurrency(snapshot, txn.accountId))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function accountCurrency(snapshot: DashboardSnapshot, accountId: string): string {
  return snapshot.accounts.find((a) => a.id === accountId)?.currency ?? 'USD'
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return amount.toFixed(2)
  }
}

function formatLastRefreshed(lastRefreshed: string | null): string {
  if (!lastRefreshed) return 'Never refreshed — click Refresh to load data.'
  return `Last refreshed: ${new Date(lastRefreshed).toLocaleString()}`
}
