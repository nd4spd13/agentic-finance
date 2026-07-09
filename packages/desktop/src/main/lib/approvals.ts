/**
 * Best-effort pending-approval count for the tray/status display (D1.3
 * shows this in the tray tooltip/menu; the settings window shows it too).
 *
 * Opens its own short-lived `ApprovalQueue` handle against the same
 * `approvals.sqlite` the spawned MCP server child writes to — SQLite
 * supports multiple readers/writers against one file, but a transient
 * `SQLITE_BUSY` under contention is possible. On any failure this returns
 * `0` rather than surfacing an error: a stale/missing count is a cosmetic
 * status-display concern here, not a functional one. (The approvals inbox
 * itself — actually acting on pending items — is Phase D2; this is a
 * read-only count only, the one explicit exception D1.3 carves out.)
 */

import { getCladCore } from './clad-core.js'

export async function getPendingApprovalsCount(approvalDbPath: string): Promise<number> {
  try {
    const { ApprovalQueue } = await getCladCore()
    const queue = new ApprovalQueue(approvalDbPath)
    try {
      return queue.listPending().length
    } finally {
      queue.close()
    }
  } catch {
    return 0
  }
}
