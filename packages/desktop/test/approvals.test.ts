import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalQueue } from '@clad/core'
import { getPendingApprovalsCount } from '../src/main/lib/approvals.js'

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
