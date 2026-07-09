import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalQueue, AuditLogger } from '@clad/core'
import {
  getPendingApprovalsCount,
  listApprovals,
  decideApproval,
  findNewPendingApprovals,
} from '../src/main/lib/approvals.js'
import type { ApprovalListItem } from '../src/shared/ipc.js'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('getPendingApprovalsCount', () => {
  it('returns 0 when the approvals db does not exist yet', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-approvals-test-'))
    const dbPath = join(dir, 'does-not-exist.sqlite')

    expect(await getPendingApprovalsCount(dbPath)).toBe(0)
  })

  it('counts only pending approvals, not approved/denied ones', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-approvals-test-'))
    const dbPath = join(dir, 'approvals.sqlite')

    const queue = new ApprovalQueue(dbPath)
    queue.createApproval('agent1', 'spend', 'reason 1')
    const toApprove = queue.createApproval('agent1', 'spend', 'reason 2')
    queue.approve(toApprove.id)
    queue.createApproval('agent2', 'transfer', 'reason 3')
    queue.close()

    expect(await getPendingApprovalsCount(dbPath)).toBe(2)
  })
})

describe('listApprovals', () => {
  it('defaults to pending-only and maps fields to the display-safe camelCase shape', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-approvals-test-'))
    const dbPath = join(dir, 'approvals.sqlite')

    const queue = new ApprovalQueue(dbPath)
    const created = queue.createApproval('agent1', 'clad_request_action', 'amount $500 exceeds limit')
    const toApprove = queue.createApproval('agent1', 'clad_request_action', 'reason 2')
    queue.approve(toApprove.id)
    queue.close()

    const pending = await listApprovals(dbPath)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      id: created.id,
      agentId: 'agent1',
      toolName: 'clad_request_action',
      triggerReason: 'amount $500 exceeds limit',
      status: 'pending',
    })
    expect(pending[0].createdAt).toBeTruthy()
    expect(pending[0].expiresAt).toBeTruthy()
  })

  it("status: 'all' includes resolved approvals too", async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-approvals-test-'))
    const dbPath = join(dir, 'approvals.sqlite')

    const queue = new ApprovalQueue(dbPath)
    queue.createApproval('agent1', 'spend', 'reason 1')
    const toApprove = queue.createApproval('agent1', 'spend', 'reason 2')
    queue.approve(toApprove.id)
    queue.close()

    const all = await listApprovals(dbPath, { status: 'all' })
    expect(all).toHaveLength(2)
  })

  it('propagates a real failure instead of swallowing it (unlike getPendingApprovalsCount)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-approvals-test-'))
    // A path inside a directory that doesn't exist — DatabaseSync throws
    // rather than auto-creating intermediate directories.
    const dbPath = join(dir, 'nested', 'does-not-exist', 'approvals.sqlite')

    await expect(listApprovals(dbPath)).rejects.toThrow()
  })
})

describe('decideApproval', () => {
  it('approves a pending approval, writes an audit escalation-decision record, and returns the updated item', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-approvals-test-'))
    const approvalDbPath = join(dir, 'approvals.sqlite')
    const auditDbPath = join(dir, 'audit.sqlite')

    const queue = new ApprovalQueue(approvalDbPath)
    const created = queue.createApproval('agent1', 'clad_request_action', 'escalation trigger matched')
    queue.close()

    const result = await decideApproval(approvalDbPath, auditDbPath, created.id, 'approve')

    expect(result.ok).toBe(true)
    expect(result.record).toMatchObject({ id: created.id, status: 'approved' })

    const verifyQueue = new ApprovalQueue(approvalDbPath)
    expect(verifyQueue.get(created.id).status).toBe('approved')
    verifyQueue.close()

    const logger = new AuditLogger(auditDbPath)
    const records = logger.getRecords({ agent_id: 'agent1' })
    logger.close()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event_type: 'escalation_decision',
      decision: 'approved',
      tool_name: 'clad_request_action',
    })
    expect(records[0].reason).toMatch(/desktop app/)
  })

  it('denies a pending approval and audit-logs a "denied" decision', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-approvals-test-'))
    const approvalDbPath = join(dir, 'approvals.sqlite')
    const auditDbPath = join(dir, 'audit.sqlite')

    const queue = new ApprovalQueue(approvalDbPath)
    const created = queue.createApproval('agent2', 'clad_request_action', 'escalation trigger matched')
    queue.close()

    const result = await decideApproval(approvalDbPath, auditDbPath, created.id, 'deny')

    expect(result.ok).toBe(true)
    expect(result.record?.status).toBe('denied')

    const logger = new AuditLogger(auditDbPath)
    const records = logger.getRecords({ agent_id: 'agent2' })
    logger.close()
    expect(records[0]).toMatchObject({ decision: 'denied' })
  })

  it('returns ok: false with a message instead of throwing when the approval id is unknown', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-approvals-test-'))
    const approvalDbPath = join(dir, 'approvals.sqlite')
    const auditDbPath = join(dir, 'audit.sqlite')
    // Ensure the approvals db exists (schema created) without any rows.
    new ApprovalQueue(approvalDbPath).close()

    const result = await decideApproval(approvalDbPath, auditDbPath, 'nonexistent-id', 'approve')

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('returns ok: false without writing an audit record when the approval is already resolved', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-approvals-test-'))
    const approvalDbPath = join(dir, 'approvals.sqlite')
    const auditDbPath = join(dir, 'audit.sqlite')

    const queue = new ApprovalQueue(approvalDbPath)
    const created = queue.createApproval('agent1', 'clad_request_action', 'reason')
    queue.approve(created.id)
    queue.close()

    const result = await decideApproval(approvalDbPath, auditDbPath, created.id, 'deny')

    expect(result.ok).toBe(false)

    const logger = new AuditLogger(auditDbPath)
    const records = logger.getRecords()
    logger.close()
    expect(records).toHaveLength(0)
  })
})

describe('findNewPendingApprovals', () => {
  function pendingItem(id: string): ApprovalListItem {
    return {
      id,
      agentId: 'agent1',
      toolName: 'clad_request_action',
      triggerReason: 'reason',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
  }

  it('returns pending items whose id is not in the previously-seen set', () => {
    const seen = new Set(['a'])
    const current = [pendingItem('a'), pendingItem('b')]

    expect(findNewPendingApprovals(seen, current).map((i) => i.id)).toEqual(['b'])
  })

  it('ignores non-pending items even if their id is new', () => {
    const seen = new Set<string>()
    const resolved: ApprovalListItem = { ...pendingItem('c'), status: 'approved' }

    expect(findNewPendingApprovals(seen, [resolved])).toEqual([])
  })

  it('returns an empty array when nothing new appeared', () => {
    const seen = new Set(['a', 'b'])
    const current = [pendingItem('a'), pendingItem('b')]

    expect(findNewPendingApprovals(seen, current)).toEqual([])
  })
})
