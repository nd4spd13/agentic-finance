/**
 * CLI unit tests — CRS-30 + CRS-29
 * Tests config, log, and approval commands in isolation (no process.exit side effects)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Use a temp dir as CLAD_CONFIG_DIR for all tests
const TEST_DIR = join(tmpdir(), `guardian-test-${process.pid}`)

beforeEach(() => {
  process.env.CLAD_CONFIG_DIR = TEST_DIR
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  delete process.env.CLAD_CONFIG_DIR
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
})

// ── Config ───────────────────────────────────────────────────────────────────

describe('Config', () => {
  it('defaultConfig returns paths under CLAD_CONFIG_DIR', async () => {
    const { defaultConfig } = await import('../src/config.js')
    const cfg = defaultConfig()
    expect(cfg.policy_path).toContain(TEST_DIR)
    expect(cfg.audit_db).toContain(TEST_DIR)
    expect(cfg.approval_db).toContain(TEST_DIR)
  })

  it('saveConfig + loadConfig roundtrip', async () => {
    const { saveConfig, loadConfig, defaultConfig } = await import('../src/config.js')
    const cfg = defaultConfig()
    saveConfig(cfg)
    const loaded = loadConfig()
    expect(loaded.policy_path).toBe(cfg.policy_path)
    expect(loaded.audit_db).toBe(cfg.audit_db)
  })

  it('loadConfig returns defaults when no config file exists', async () => {
    const { loadConfig, defaultConfig } = await import('../src/config.js')
    const defaults = defaultConfig()
    const loaded = loadConfig()
    expect(loaded.audit_db).toBe(defaults.audit_db)
  })
})

// ── Log command ───────────────────────────────────────────────────────────────

describe('Log command', () => {
  it('logCommand prints "No audit log found" when db missing', async () => {
    const { logCommand } = await import('../src/commands/log.js')
    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    logCommand()
    console.log = orig
    expect(logs.some(l => l.includes('No audit log'))).toBe(true)
  })

  it('logExportCommand writes JSON to file', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { AuditLogger } = await import('@clad/core')
    const { logExportCommand } = await import('../src/commands/log.js')

    const config = loadConfig()
    const logger = new AuditLogger(config.audit_db)
    logger.logRequest('agent1', 'get_balances', 'allow', 'test reason')

    const outFile = join(TEST_DIR, 'export.json')
    logExportCommand(outFile)

    expect(existsSync(outFile)).toBe(true)
    const { readFileSync } = await import('node:fs')
    const data = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBe(1)
    expect(data[0].agent_id).toBe('agent1')
  })

  it('logExportCommand writes CSV to file', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { AuditLogger } = await import('@clad/core')
    const { logExportCommand } = await import('../src/commands/log.js')

    const config = loadConfig()
    const logger = new AuditLogger(config.audit_db)
    logger.logRequest('agent1', 'get_balances', 'allow', 'test reason')

    const outFile = join(TEST_DIR, 'export.csv')
    logExportCommand(outFile)

    expect(existsSync(outFile)).toBe(true)
    const { readFileSync } = await import('node:fs')
    const csv = readFileSync(outFile, 'utf-8')
    expect(csv).toContain('id,timestamp,agent_id')
    expect(csv).toContain('agent1')
  })
})

// ── Approval commands ────────────────────────────────────────────────────────

describe('Approval commands (HITL)', () => {
  it('approvalsListCommand prints "No approval queue found" when db missing', async () => {
    const { approvalsListCommand } = await import('../src/commands/approvals.js')
    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    approvalsListCommand()
    console.log = orig
    expect(logs.some(l => l.includes('No approval queue'))).toBe(true)
  })

  it('approveCommand approves a pending approval', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { ApprovalQueue } = await import('@clad/core')
    const { approveCommand } = await import('../src/commands/approvals.js')

    const config = loadConfig()
    const queue = new ApprovalQueue(config.approval_db)
    const record = queue.createApproval('agent1', 'spend', 'exceeds limit')

    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    approveCommand(record.id)
    console.log = orig

    expect(logs.some(l => l.includes('✓ Approved'))).toBe(true)

    // Verify in DB
    const updated = queue.get(record.id)
    expect(updated.status).toBe('approved')
  })

  it('denyCommand denies a pending approval', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { ApprovalQueue } = await import('@clad/core')
    const { denyCommand } = await import('../src/commands/approvals.js')

    const config = loadConfig()
    const queue = new ApprovalQueue(config.approval_db)
    const record = queue.createApproval('agent1', 'spend', 'exceeds limit')

    denyCommand(record.id)

    const updated = queue.get(record.id)
    expect(updated.status).toBe('denied')
  })

  it('lockdownCommand denies all pending approvals', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { ApprovalQueue } = await import('@clad/core')
    const { lockdownCommand } = await import('../src/commands/approvals.js')

    const config = loadConfig()
    const queue = new ApprovalQueue(config.approval_db)
    const r1 = queue.createApproval('agent1', 'spend', 'reason 1')
    const r2 = queue.createApproval('agent2', 'transfer', 'reason 2')

    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    lockdownCommand()
    console.log = orig

    expect(queue.get(r1.id).status).toBe('denied')
    expect(queue.get(r2.id).status).toBe('denied')
    expect(logs.some(l => l.includes('Lockdown'))).toBe(true)
  })

  it('approvals --all shows all statuses', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { ApprovalQueue } = await import('@clad/core')
    const { approvalsListCommand } = await import('../src/commands/approvals.js')

    const config = loadConfig()
    const queue = new ApprovalQueue(config.approval_db)
    const r1 = queue.createApproval('agent1', 'spend', 'reason 1')
    queue.approve(r1.id)
    queue.createApproval('agent2', 'transfer', 'reason 2') // pending

    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    approvalsListCommand({ all: true })
    console.log = orig

    const output = logs.join('\n')
    expect(output).toContain('All Approvals (2)')
  })
})

// ── Escalation audit logging (CRS-44) ────────────────────────────────────────

describe('Escalation decision audit logging', () => {
  it('approveCommand writes an escalation_decision record to the audit log', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { ApprovalQueue, AuditLogger } = await import('@guardian-layer/core')
    const { approveCommand } = await import('../src/commands/approvals.js')

    const config = loadConfig()
    // Seed the audit log so getAuditLogger() finds the DB
    const logger = new AuditLogger(config.audit_db)
    const queue = new ApprovalQueue(config.approval_db)
    const record = queue.createApproval('agent1', 'spend', 'exceeds limit')

    approveCommand(record.id)

    const auditRecords = logger.getRecords({ agent_id: 'agent1' })
    const decision = auditRecords.find(r => r.event_type === 'escalation_decision')
    expect(decision).toBeDefined()
    expect(decision?.decision).toBe('approved')
    expect(decision?.payload).toContain(record.id)
  })

  it('denyCommand writes an escalation_decision record to the audit log', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { ApprovalQueue, AuditLogger } = await import('@guardian-layer/core')
    const { denyCommand } = await import('../src/commands/approvals.js')

    const config = loadConfig()
    const logger = new AuditLogger(config.audit_db)
    const queue = new ApprovalQueue(config.approval_db)
    const record = queue.createApproval('agent2', 'transfer', 'new merchant')

    denyCommand(record.id)

    const auditRecords = logger.getRecords({ agent_id: 'agent2' })
    const decision = auditRecords.find(r => r.event_type === 'escalation_decision')
    expect(decision).toBeDefined()
    expect(decision?.decision).toBe('denied')
    expect(decision?.reason).toContain('CLI')
  })

  it('lockdownCommand writes one escalation_decision record per denial', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { ApprovalQueue, AuditLogger } = await import('@guardian-layer/core')
    const { lockdownCommand } = await import('../src/commands/approvals.js')

    const config = loadConfig()
    const logger = new AuditLogger(config.audit_db)
    const queue = new ApprovalQueue(config.approval_db)
    queue.createApproval('agentA', 'spend', 'reason 1')
    queue.createApproval('agentB', 'transfer', 'reason 2')
    queue.createApproval('agentC', 'spend', 'reason 3')

    lockdownCommand()

    const decisions = logger.getRecords().filter(r => r.event_type === 'escalation_decision')
    expect(decisions).toHaveLength(3)
    expect(decisions.every(d => d.decision === 'denied')).toBe(true)
    expect(decisions.every(d => d.reason?.includes('lockdown'))).toBe(true)
  })

  it('audit chain remains valid after mixed request + escalation_decision records', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { ApprovalQueue, AuditLogger } = await import('@guardian-layer/core')
    const { approveCommand } = await import('../src/commands/approvals.js')

    const config = loadConfig()
    const logger = new AuditLogger(config.audit_db)
    const queue = new ApprovalQueue(config.approval_db)

    // Seed a normal request record
    logger.logRequest('agent1', 'get_balances', 'allow', 'within policy')

    // Approve an escalation (adds escalation_decision record)
    const record = queue.createApproval('agent1', 'spend', 'limit exceeded')
    approveCommand(record.id)

    expect(logger.verifyChain()).toBe(true)
  })
})

// ── Policy commands ──────────────────────────────────────────────────────────

describe('Policy commands', () => {
  it('policyValidateCommand validates a valid policy file', async () => {
    const { policyValidateCommand } = await import('../src/commands/policy.js')

    // Use the fixture policy from core (fileURLToPath handles spaces correctly)
    const { fileURLToPath } = await import('node:url')
    // test/ -> cli/ -> packages/ -> clad/fixtures/...
    const fixturePath = fileURLToPath(
      new URL('../../../fixtures/policies/valid-basic.yaml', import.meta.url)
    )

    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    await policyValidateCommand(fixturePath)
    console.log = orig

    expect(logs.some(l => l.includes('✓ Policy is valid'))).toBe(true)
  })
})
