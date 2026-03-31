/**
 * guardian status — show server and policy status
 */

import { existsSync, readFileSync } from 'node:fs'
import { loadConfig } from '../config.js'
import { AuditLogger, ApprovalQueue, parsePolicy } from '@guardian-layer/core'

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function statusCommand(): Promise<void> {
  const config = loadConfig()

  console.log('\n🛡️  Guardian Layer Status\n')

  // Server status
  let serverStatus = 'stopped'
  let serverPid: number | null = null
  if (existsSync(config.server_pid_file)) {
    const pidStr = readFileSync(config.server_pid_file, 'utf-8').trim()
    const pid = parseInt(pidStr, 10)
    if (!isNaN(pid) && isRunning(pid)) {
      serverStatus = 'running'
      serverPid = pid
    }
  }

  const statusIcon = serverStatus === 'running' ? '🟢' : '🔴'
  console.log(`Server:   ${statusIcon} ${serverStatus}${serverPid ? ` (PID ${serverPid})` : ''}`)

  // Policy status
  if (existsSync(config.policy_path)) {
    try {
      const policy = await parsePolicy(config.policy_path)
      const agentCount = Object.keys(policy.agents ?? {}).length
      console.log(`Policy:   ✓ valid (${agentCount} agent${agentCount !== 1 ? 's' : ''} configured)`)
      console.log(`          ${config.policy_path}`)
    } catch (err) {
      console.log(`Policy:   ✗ invalid — ${err}`)
    }
  } else {
    console.log(`Policy:   ⚠  not found at ${config.policy_path}`)
    console.log(`          Run: guardian init`)
  }

  // Pending approvals
  if (existsSync(config.approval_db)) {
    try {
      const queue = new ApprovalQueue(config.approval_db)
      const pending = queue.listPending()
      const pendingCount = pending.length
      if (pendingCount > 0) {
        console.log(`\nApprovals: ⚠  ${pendingCount} pending`)
        console.log(`           Run: guardian approvals`)
      } else {
        console.log(`Approvals: ✓ none pending`)
      }
    } catch {
      console.log(`Approvals: (db not initialized)`)
    }
  } else {
    console.log(`Approvals: (not initialized)`)
  }

  // Audit trail
  if (existsSync(config.audit_db)) {
    try {
      const logger = new AuditLogger(config.audit_db)
      const records = logger.getRecords()
      console.log(`Audit log: ${records.length} record${records.length !== 1 ? 's' : ''}`)
    } catch {
      console.log(`Audit log: (db not initialized)`)
    }
  } else {
    console.log(`Audit log: (not initialized)`)
  }

  console.log('')
}
