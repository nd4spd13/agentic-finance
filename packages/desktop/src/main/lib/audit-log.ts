/**
 * D2.2: read-only, paginated, filterable view over the audit SQLite for the
 * renderer's audit log viewer. Queries stay entirely in this module (main
 * process) — only one page of display-safe rows ever crosses IPC (see
 * `AuditLogPage` in `shared/ipc.ts`), never the whole log.
 *
 * `@clad/core`'s `AuditLogger.getRecords(filters)` already does the
 * agent/tool/decision/date filtering in SQL and returns oldest-first (its
 * hash-chain verification order); this module reverses that to newest-first
 * for display and paginates in memory. No new SQL/schema here — reusing the
 * same filter surface the CLI's own audit tooling uses keeps this from
 * inventing a parallel query path against the hash-chained table.
 *
 * Propagates real read failures (corrupt/locked DB, etc.) rather than
 * swallowing them, same posture as `listApprovals` in `approvals.ts`: this
 * feeds a user-watched screen, so `index.ts`'s IPC handler lets failures
 * reject and the renderer shows a genuine error state.
 */

import type { AuditLogFilter, AuditLogPage, AuditLogRow } from '../../shared/ipc.js'
import { getCladCore } from './clad-core.js'

/**
 * Structural shape of `@clad/core`'s `AuditRecord` — a standalone copy, not
 * a type import (same reasoning as `ApprovalRecordShape` in
 * `approvals.ts`: this package's ESLint config blocks EVERY `@clad/core`
 * import from `src/main/**`, type-only or not).
 */
interface AuditRecordShape {
  id: string
  timestamp: string
  agent_id: string
  event_type: string
  tool_name?: string
  decision?: string
  reason?: string
}

function toRow(record: AuditRecordShape): AuditLogRow {
  return {
    id: record.id,
    timestamp: record.timestamp,
    agentId: record.agent_id,
    eventType: record.event_type,
    toolName: record.tool_name,
    decision: record.decision,
    reason: record.reason,
  }
}

export async function queryAuditLog(
  auditDbPath: string,
  filter: AuditLogFilter,
  page: number,
  pageSize: number
): Promise<AuditLogPage> {
  const { AuditLogger } = await getCladCore()
  const logger = new AuditLogger(auditDbPath)
  try {
    const records = logger.getRecords({
      agent_id: filter.agentId || undefined,
      decision: filter.decision || undefined,
      tool_name: filter.toolName || undefined,
      start_time: filter.startDate ? new Date(filter.startDate) : undefined,
      end_time: filter.endDate ? new Date(filter.endDate) : undefined,
    })

    // `getRecords` returns oldest-first (hash-chain order) — reverse for the
    // "newest first" display the plan calls for.
    const newestFirst = [...records].reverse()
    const total = newestFirst.length
    const clampedPageSize = Math.max(1, pageSize)
    const totalPages = Math.max(1, Math.ceil(total / clampedPageSize))
    const clampedPage = Math.min(Math.max(1, page), totalPages)
    const start = (clampedPage - 1) * clampedPageSize
    const rows = newestFirst.slice(start, start + clampedPageSize).map(toRow)

    return { rows, total, page: clampedPage, pageSize: clampedPageSize }
  } finally {
    logger.close()
  }
}
