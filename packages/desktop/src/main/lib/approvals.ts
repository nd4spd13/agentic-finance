/**
 * Approvals — D1.3's best-effort pending count, plus the D2.1 approvals
 * inbox: listing, approve/deny (writing through the real `@clad/core`
 * `ApprovalQueue` and audit-logging the decision, mirroring
 * `packages/cli/src/commands/approvals.ts`'s `approveCommand`/`denyCommand`
 * exactly — same queue call, same `logEscalationDecision` call, just a
 * different `reason` string), and the pure new-pending-approval diff that
 * drives the D2.1 OS notification.
 *
 * Two different error-handling postures on purpose:
 *  - `getPendingApprovalsCount` (tray/status, D1.3): best-effort, returns 0
 *    on any failure — a stale/missing count is a cosmetic status-display
 *    concern, not a functional one.
 *  - `listApprovals`/`decideApproval` (D2.1 inbox, a user-watched screen):
 *    `listApprovals` propagates real failures (so `index.ts`'s IPC handler
 *    can let them reject, and the renderer shows a genuine error state
 *    instead of a silently-empty list); `decideApproval` catches internally
 *    and returns an `ApprovalDecisionResult` (`{ ok, error }`), matching the
 *    rest of this app's mutation-style IPC handlers (`configSetProviderAndEnv`
 *    et al. in `main/index.ts`).
 */

import type { ApprovalDecisionResult, ApprovalListItem, ApprovalStatus } from '../../shared/ipc.js'
import { getCladCore } from './clad-core.js'

/**
 * Structural shape of `@clad/core`'s `ApprovalRecord` — a standalone copy,
 * not a type import (same convention as `McpServerState` in
 * `mcp-server-manager.ts`/`shared/ipc.ts`). This package's ESLint config
 * (`.eslintrc.cjs`) blocks EVERY `@clad/core` import from `src/main/**`,
 * type-only or not, so "only `clad-core.ts`'s dynamic `import()` touches
 * this package" stays one simple, mechanically-enforced rule with no
 * exceptions to remember. TypeScript's structural typing means the real
 * `ApprovalRecord` instances returned through `getCladCore()` satisfy this
 * shape with no import needed.
 */
interface ApprovalRecordShape {
  id: string
  agent_id: string
  tool_name: string
  trigger_reason: string
  status: string
  created_at: string
  expires_at: string
  resolved_at?: string
}

function toListItem(record: ApprovalRecordShape): ApprovalListItem {
  return {
    id: record.id,
    agentId: record.agent_id,
    toolName: record.tool_name,
    triggerReason: record.trigger_reason,
    status: record.status as ApprovalStatus,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
    resolvedAt: record.resolved_at,
  }
}

/**
 * Lists approvals for the D2.1 inbox — pending-only by default (the inbox's
 * default view), or `status: 'all'` for full history. Propagates errors
 * (opening a corrupt/locked DB, etc.) rather than swallowing them: this
 * feeds a user-watched screen, so a real failure should surface as a real
 * error state, not a silent empty list.
 */
export async function listApprovals(
  approvalDbPath: string,
  opts?: { status?: ApprovalStatus | 'all' }
): Promise<ApprovalListItem[]> {
  const { ApprovalQueue } = await getCladCore()
  const queue = new ApprovalQueue(approvalDbPath)
  try {
    // Omitted `opts`/`opts.status` defaults to `'pending'` (the inbox's
    // default view) — only an explicit `status: 'all'` drops the filter.
    const status = opts?.status ?? 'pending'
    const filter = status === 'all' ? undefined : { status }
    return queue.list(filter).map(toListItem)
  } finally {
    queue.close()
  }
}

/**
 * Best-effort pending-approval count for the tray/status display (D1.3
 * shows this in the tray tooltip/menu; the settings window shows it too).
 * On any failure this returns `0` rather than surfacing an error: a
 * stale/missing count is a cosmetic status-display concern here, not a
 * functional one.
 */
export async function getPendingApprovalsCount(approvalDbPath: string): Promise<number> {
  try {
    return (await listApprovals(approvalDbPath, { status: 'pending' })).length
  } catch {
    return 0
  }
}

/**
 * Approves or denies a pending approval and audit-logs the human decision —
 * the exact same two calls `packages/cli/src/commands/approvals.ts`'s
 * `approveCommand`/`denyCommand` make (`queue.approve`/`queue.deny` then
 * `logger.logEscalationDecision`), just with a `reason` string that says
 * "desktop app" instead of "CLI" so the audit trail records which surface
 * made the decision. Never throws — mirrors the rest of this app's
 * mutation-style IPC handlers, which return `{ ok, error }` rather than
 * rejecting.
 */
export async function decideApproval(
  approvalDbPath: string,
  auditDbPath: string,
  id: string,
  decision: 'approve' | 'deny'
): Promise<ApprovalDecisionResult> {
  const { ApprovalQueue, AuditLogger } = await getCladCore()

  let record: ApprovalRecordShape
  const queue = new ApprovalQueue(approvalDbPath)
  try {
    record = decision === 'approve' ? queue.approve(id) : queue.deny(id)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    queue.close()
  }

  // The approval decision itself already committed above; audit-logging it
  // is best-effort from here on (same "don't let a secondary write undo the
  // primary one" posture as the CLI's `getAuditLogger()` being allowed to
  // return `null`) — a failure to log doesn't unwind the approve/deny.
  try {
    const logger = new AuditLogger(auditDbPath)
    try {
      logger.logEscalationDecision(
        record.agent_id,
        record.tool_name,
        decision === 'approve' ? 'approved' : 'denied',
        `human ${decision === 'approve' ? 'approved' : 'denied'} via desktop app`,
        record.id
      )
    } finally {
      logger.close()
    }
  } catch {
    // best-effort — see doc comment above.
  }

  return { ok: true, record: toListItem(record) }
}

/**
 * Pure diff used to drive the D2.1 native OS notification: which currently-
 * pending approvals weren't in the previously-seen id set. Split out as a
 * pure function (no `electron` import) so it's unit-testable under plain
 * Vitest — `main/index.ts` owns the actual `previouslySeenIds` state and
 * calls this from the same 15s/on-status-change cadence that already drives
 * the tray's pending count (see `broadcastStatus` there), rather than
 * standing up a second poll loop.
 */
export function findNewPendingApprovals(
  previouslySeenIds: ReadonlySet<string>,
  currentPending: ApprovalListItem[]
): ApprovalListItem[] {
  return currentPending.filter((item) => item.status === 'pending' && !previouslySeenIds.has(item.id))
}
