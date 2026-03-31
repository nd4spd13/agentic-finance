import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { unlinkSync, existsSync } from 'fs'

describe('Approval Queue', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = '/tmp/test-approvals.db'
    if (existsSync(dbPath)) unlinkSync(dbPath)
  })

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath)
  })

  describe('ApprovalQueue', () => {
    it('creating approval returns pending with ID + expiry', async () => {
      const { ApprovalQueue } = await import('../../src/approval/queue.js')
      const queue = new ApprovalQueue(dbPath)

      const record = queue.createApproval('agent1', 'get_balances', 'Amount exceeds limit')
      expect(record.status).toBe('pending')
      expect(record.id).toBeDefined()
      expect(record.expires_at).toBeDefined()
    })

    it('approving → approved status', async () => {
      const { ApprovalQueue } = await import('../../src/approval/queue.js')
      const queue = new ApprovalQueue(dbPath)

      const record = queue.createApproval('agent1', 'get_balances', 'Test')
      const updated = queue.approve(record.id)
      expect(updated.status).toBe('approved')
    })

    it('denying → denied status', async () => {
      const { ApprovalQueue } = await import('../../src/approval/queue.js')
      const queue = new ApprovalQueue(dbPath)

      const record = queue.createApproval('agent1', 'get_balances', 'Test')
      const updated = queue.deny(record.id)
      expect(updated.status).toBe('denied')
    })

    it('expired → auto-deny on check', async () => {
      const { ApprovalQueue } = await import('../../src/approval/queue.js')
      const queue = new ApprovalQueue(dbPath)

      const record = queue.createApproval('agent1', 'get_balances', 'Test', '1ms')
      // Wait for expiry
      await new Promise(r => setTimeout(r, 10))
      const checked = queue.get(record.id)
      expect(checked.status).toBe('expired')
    })

    it('duplicate resolution → already-resolved error', async () => {
      const { ApprovalQueue } = await import('../../src/approval/queue.js')
      const queue = new ApprovalQueue(dbPath)

      const record = queue.createApproval('agent1', 'get_balances', 'Test')
      queue.approve(record.id)

      expect(() => {
        queue.approve(record.id)
      }).toThrow()
    })

    it('trigger_reason from policy evaluation', async () => {
      const { ApprovalQueue } = await import('../../src/approval/queue.js')
      const queue = new ApprovalQueue(dbPath)

      const reason = 'Amount exceeds daily limit by 50%'
      const record = queue.createApproval('agent1', 'spend', reason)
      expect(record.trigger_reason).toBe(reason)
    })

    it('max_pending_escalations limit', async () => {
      const { ApprovalQueue } = await import('../../src/approval/queue.js')
      const queue = new ApprovalQueue(dbPath, { max_pending: 2 })

      queue.createApproval('agent1', 'tool1', 'Reason 1')
      queue.createApproval('agent1', 'tool2', 'Reason 2')

      expect(() => {
        queue.createApproval('agent1', 'tool3', 'Reason 3')
      }).toThrow()
    })
  })
})
