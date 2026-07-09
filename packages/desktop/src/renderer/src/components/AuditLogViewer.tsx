import { useCallback, useEffect, useState } from 'react'
import type { AuditLogFilter, AuditLogRow } from '../../../shared/ipc.js'
import * as s from '../styles.js'

const PAGE_SIZE = 25

const DECISION_OPTIONS = ['allow', 'deny', 'escalate', 'approved', 'denied']

/**
 * D2.2 — read-only, paginated, filterable view over the audit SQLite.
 * Filters (agent, tool, decision, date range) are applied in the main
 * process (`main/lib/audit-log.ts`'s `queryAuditLog`); only one page of
 * display-safe rows ever crosses IPC. Newest-first. No mutations — there is
 * no write path from this component at all.
 */
export default function AuditLogViewer(): JSX.Element {
  const [rows, setRows] = useState<AuditLogRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<AuditLogFilter>({})
  const [draftFilter, setDraftFilter] = useState<AuditLogFilter>({})

  const load = useCallback(async (targetPage: number, activeFilter: AuditLogFilter) => {
    try {
      const result = await window.clad.queryAuditLog({
        filter: activeFilter,
        page: targetPage,
        pageSize: PAGE_SIZE,
      })
      setRows(result.rows)
      setTotal(result.total)
      setPage(result.page)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load(1, filter)
  }, [load, filter])

  function applyFilters(event: React.FormEvent): void {
    event.preventDefault()
    setFilter(draftFilter)
  }

  function clearFilters(): void {
    setDraftFilter({})
    setFilter({})
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div style={s.card}>
      <h2 style={{ marginTop: 0 }}>Audit log</h2>

      <form onSubmit={applyFilters} style={s.filterBar}>
        <input
          style={s.filterInput}
          placeholder="Agent ID"
          value={draftFilter.agentId ?? ''}
          onChange={(e) => setDraftFilter({ ...draftFilter, agentId: e.target.value || undefined })}
        />
        <input
          style={s.filterInput}
          placeholder="Tool name"
          value={draftFilter.toolName ?? ''}
          onChange={(e) => setDraftFilter({ ...draftFilter, toolName: e.target.value || undefined })}
        />
        <select
          style={s.filterInput}
          value={draftFilter.decision ?? ''}
          onChange={(e) => setDraftFilter({ ...draftFilter, decision: e.target.value || undefined })}
        >
          <option value="">Any decision</option>
          {DECISION_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <input
          type="date"
          style={s.filterInput}
          value={draftFilter.startDate ?? ''}
          onChange={(e) => setDraftFilter({ ...draftFilter, startDate: e.target.value || undefined })}
        />
        <input
          type="date"
          style={s.filterInput}
          value={draftFilter.endDate ?? ''}
          onChange={(e) => setDraftFilter({ ...draftFilter, endDate: e.target.value || undefined })}
        />
        <button type="submit" style={s.button}>
          Filter
        </button>
        <button type="button" style={s.buttonSecondary} onClick={clearFilters}>
          Clear
        </button>
      </form>

      {error && (
        <p style={s.errorText}>
          {error}{' '}
          <button type="button" style={s.buttonSecondary} onClick={() => void load(page, filter)}>
            Retry
          </button>
        </p>
      )}

      {rows === null && !error && <p style={s.mutedText}>Loading audit log…</p>}

      {rows !== null && rows.length === 0 && !error && (
        <p style={s.mutedText}>No audit records match these filters.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr style={s.tableHeaderRow}>
                  <th style={s.tableCell}>When</th>
                  <th style={s.tableCell}>Agent</th>
                  <th style={s.tableCell}>Event</th>
                  <th style={s.tableCell}>Tool</th>
                  <th style={s.tableCell}>Decision</th>
                  <th style={s.tableCell}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={s.tableRow}>
                    <td style={{ ...s.tableCell, whiteSpace: 'nowrap' }}>
                      {new Date(r.timestamp).toLocaleString()}
                    </td>
                    <td style={s.tableCell}>{r.agentId}</td>
                    <td style={s.tableCell}>{r.eventType}</td>
                    <td style={s.tableCell}>{r.toolName ?? '—'}</td>
                    <td style={s.tableCell}>{r.decision ?? '—'}</td>
                    <td style={s.tableCell}>{r.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={s.pagination}>
            <button
              type="button"
              style={s.buttonSecondary}
              disabled={page <= 1}
              onClick={() => void load(page - 1, filter)}
            >
              Prev
            </button>
            <span style={s.mutedText}>
              Page {page} of {totalPages} ({total} record{total === 1 ? '' : 's'})
            </span>
            <button
              type="button"
              style={s.buttonSecondary}
              disabled={page >= totalPages}
              onClick={() => void load(page + 1, filter)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  )
}
