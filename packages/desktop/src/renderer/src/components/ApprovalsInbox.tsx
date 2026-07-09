import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalListItem, ApprovalStatus } from '../../../shared/ipc.js'
import * as s from '../styles.js'

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired',
}

const STATUS_COLOR: Record<ApprovalStatus, string> = {
  pending: '#8a6d00',
  approved: '#1e7a34',
  denied: '#b3261e',
  expired: '#666',
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function timeUntil(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now()
  if (diffMs <= 0) return 'expired'
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/**
 * D2.1 — the flagship feature. Lists pending approvals from the
 * `@clad/core` approval queue (agent, tool, why it escalated, when it was
 * created/expires) with Approve/Deny actions that write through the real
 * queue and get audit-logged (see `main/lib/approvals.ts`'s `decideApproval`
 * — same two calls the CLI's `clad approve`/`clad deny` make).
 *
 * Refreshes on the same push cadence `ServerStatusPanel` already subscribes
 * to (`onMcpStatusChanged` — the 15s interval + every real MCP status
 * change in `main/index.ts`'s `broadcastStatus`) rather than adding a
 * second poll loop of its own; that's also what drives the native OS
 * notification for newly-appeared approvals on the main-process side.
 *
 * `focusApprovalId` is set by `App.tsx` when the user clicks that
 * notification (`onApprovalFocusRequested`) — this component scrolls to and
 * highlights the matching row once it's loaded.
 */
export default function ApprovalsInbox({
  focusApprovalId,
}: {
  focusApprovalId?: string | null
}): JSX.Element {
  const [items, setItems] = useState<ApprovalListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement | null>())

  const load = useCallback(async (all: boolean) => {
    try {
      const list = await window.clad.listApprovals(all ? { status: 'all' } : { status: 'pending' })
      setItems(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load(showAll)
  }, [load, showAll])

  useEffect(() => {
    const unsubscribe = window.clad.onMcpStatusChanged(() => {
      void load(showAll)
    })
    return unsubscribe
  }, [load, showAll])

  useEffect(() => {
    if (!focusApprovalId) return
    rowRefs.current.get(focusApprovalId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusApprovalId, items])

  async function decide(id: string, decision: 'approve' | 'deny'): Promise<void> {
    setBusyId(id)
    try {
      const result = await window.clad.decideApproval({ id, decision })
      if (!result.ok) {
        setError(result.error ?? `Could not ${decision} this approval.`)
        return
      }
      await load(showAll)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div style={s.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ marginTop: 0 }}>Approvals</h2>
        <label style={s.mutedText}>
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            style={{ marginRight: 4 }}
          />
          Show resolved
        </label>
      </div>

      {error && (
        <p style={s.errorText}>
          {error}{' '}
          <button type="button" style={s.buttonSecondary} onClick={() => void load(showAll)}>
            Retry
          </button>
        </p>
      )}

      {items === null && !error && <p style={s.mutedText}>Loading approvals…</p>}

      {items !== null && items.length === 0 && !error && (
        <p style={s.mutedText}>
          {showAll ? 'No approvals yet.' : "No pending approvals — you're all caught up."}
        </p>
      )}

      {items !== null &&
        items.map((item) => (
          <div
            key={item.id}
            ref={(node) => {
              rowRefs.current.set(item.id, node)
            }}
            style={item.id === focusApprovalId ? s.listItemHighlighted : s.listItem}
          >
            <p style={{ margin: 0 }}>
              <strong>{item.agentId}</strong> requested <strong>{item.toolName}</strong>{' '}
              <span style={{ color: STATUS_COLOR[item.status] }}>● {STATUS_LABEL[item.status]}</span>
            </p>
            <p style={s.mutedText}>{item.triggerReason}</p>
            <p style={s.mutedText}>
              {timeAgo(item.createdAt)}
              {item.status === 'pending' && ` · expires in ${timeUntil(item.expiresAt)}`}
              {item.resolvedAt && ` · resolved ${timeAgo(item.resolvedAt)}`}
            </p>
            {item.status === 'pending' && (
              <div>
                <button
                  type="button"
                  style={s.button}
                  disabled={busyId === item.id}
                  onClick={() => void decide(item.id, 'approve')}
                >
                  Approve
                </button>
                <button
                  type="button"
                  style={s.buttonDanger}
                  disabled={busyId === item.id}
                  onClick={() => void decide(item.id, 'deny')}
                >
                  Deny
                </button>
              </div>
            )}
          </div>
        ))}
    </div>
  )
}
