import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLogger } from '@clad/core'
import { queryAuditLog } from '../src/main/lib/audit-log.js'

/** `AuditLogger` timestamps with millisecond resolution — sleep between inserts in these tests so ordering assertions don't depend on same-millisecond tie-breaking. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function makeDb(dir: string): string {
  return join(dir, 'audit.sqlite')
}

describe('queryAuditLog', () => {
  it('returns an empty page when the audit db has no matching records', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-audit-log-test-'))
    const dbPath = makeDb(dir)
    new AuditLogger(dbPath).close()

    const page = await queryAuditLog(dbPath, {}, 1, 25)

    expect(page).toEqual({ rows: [], total: 0, page: 1, pageSize: 25 })
  })

  it('returns rows newest-first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-audit-log-test-'))
    const dbPath = makeDb(dir)
    const logger = new AuditLogger(dbPath)
    logger.logRequest('agent1', 'clad_get_balances', 'allow', 'first')
    await sleep(5)
    logger.logRequest('agent1', 'clad_get_transactions', 'allow', 'second')
    await sleep(5)
    logger.logRequest('agent1', 'clad_safe_to_spend', 'allow', 'third')
    logger.close()

    const page = await queryAuditLog(dbPath, {}, 1, 25)

    expect(page.total).toBe(3)
    expect(page.rows.map((r) => r.reason)).toEqual(['third', 'second', 'first'])
  })

  it('filters by agentId, toolName, and decision', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-audit-log-test-'))
    const dbPath = makeDb(dir)
    const logger = new AuditLogger(dbPath)
    logger.logRequest('agent1', 'clad_get_balances', 'allow', 'a')
    logger.logRequest('agent2', 'clad_get_balances', 'deny', 'b')
    logger.logRequest('agent1', 'clad_request_action', 'allow', 'c')
    logger.close()

    const byAgent = await queryAuditLog(dbPath, { agentId: 'agent1' }, 1, 25)
    expect(byAgent.total).toBe(2)

    const byTool = await queryAuditLog(dbPath, { toolName: 'clad_get_balances' }, 1, 25)
    expect(byTool.total).toBe(2)

    const byDecision = await queryAuditLog(dbPath, { decision: 'deny' }, 1, 25)
    expect(byDecision.total).toBe(1)
    expect(byDecision.rows[0].reason).toBe('b')
  })

  it('filters by date range', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-audit-log-test-'))
    const dbPath = makeDb(dir)
    const logger = new AuditLogger(dbPath)
    logger.logRequest('agent1', 'clad_get_balances', 'allow', 'a')
    logger.close()

    const farFuture = await queryAuditLog(dbPath, { startDate: '2999-01-01' }, 1, 25)
    expect(farFuture.total).toBe(0)

    const farPast = await queryAuditLog(dbPath, { endDate: '2000-01-01' }, 1, 25)
    expect(farPast.total).toBe(0)

    const wideRange = await queryAuditLog(dbPath, { startDate: '2000-01-01', endDate: '2999-01-01' }, 1, 25)
    expect(wideRange.total).toBe(1)
  })

  it('paginates: page 1 and page 2 split the result set without overlap', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-audit-log-test-'))
    const dbPath = makeDb(dir)
    const logger = new AuditLogger(dbPath)
    for (let i = 0; i < 5; i++) {
      logger.logRequest('agent1', 'clad_get_balances', 'allow', `record-${i}`)
      await sleep(5)
    }
    logger.close()

    const page1 = await queryAuditLog(dbPath, {}, 1, 2)
    const page2 = await queryAuditLog(dbPath, {}, 2, 2)
    const page3 = await queryAuditLog(dbPath, {}, 3, 2)

    expect(page1.rows).toHaveLength(2)
    expect(page2.rows).toHaveLength(2)
    expect(page3.rows).toHaveLength(1)
    expect(page1.total).toBe(5)

    const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id)
    expect(new Set(allIds).size).toBe(5)
    // Newest-first across the whole set: record-4 first, record-0 last.
    expect(page1.rows[0].reason).toBe('record-4')
    expect(page3.rows[0].reason).toBe('record-0')
  })

  it('clamps an out-of-range page to the last valid page instead of returning an empty page', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-audit-log-test-'))
    const dbPath = makeDb(dir)
    const logger = new AuditLogger(dbPath)
    logger.logRequest('agent1', 'clad_get_balances', 'allow', 'only-one')
    logger.close()

    const page = await queryAuditLog(dbPath, {}, 99, 25)

    expect(page.page).toBe(1)
    expect(page.rows).toHaveLength(1)
  })
})
