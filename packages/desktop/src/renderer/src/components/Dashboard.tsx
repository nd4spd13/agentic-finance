import { useCallback, useEffect, useState } from 'react'
import type { DashboardSnapshot } from '../../../shared/ipc.js'
import * as s from '../styles.js'

/**
 * D2.3 dashboard: balances + recent transactions via the main process's
 * provider-agnostic adapter layer (`main/lib/dashboard-data.ts` +
 * `provider-factory.ts` — dummy or Plaid today, SimpleFIN slots in later
 * with no change here).
 *
 * RATE-LIMIT DISCIPLINE (desktop-app.md D2.3, critical): mounting this
 * component only ever reads the cache (`getDashboardSnapshot`) — it never
 * triggers a fetch on its own, and there is no polling interval anywhere in
 * this file. The "Refresh" button is the ONLY user action that calls
 * `refreshDashboard`, which is the only IPC call that ever reaches a real
 * provider. The `lastRefreshed` stamp is shown next to it so stale data is
 * never mistaken for live data.
 */
export default function Dashboard(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

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

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      setSnapshot(await window.clad.refreshDashboard())
    } finally {
      setRefreshing(false)
    }
  }

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
          snapshot.accounts.map((account) => (
            <div key={account.id} style={s.listRow}>
              <div>
                <div>{account.name}</div>
                <div style={s.mutedText}>
                  {account.type}
                  {account.mask && ` · •••• ${account.mask}`}
                  {account.stale && ' · stale'}
                </div>
              </div>
              <div style={account.balanceCurrent < 0 ? s.amountNegative : undefined}>
                {formatCurrency(account.balanceCurrent, account.currency)}
              </div>
            </div>
          ))
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
