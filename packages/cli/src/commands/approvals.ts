/**
 * clad approvals / approve / deny / lockdown
 * CRS-29: Human-in-the-Loop approval commands
 * CRS-44: Escalation decisions are written to the audit log
 */

import { existsSync } from 'node:fs'
import { loadConfig } from '../config.js'
import { ApprovalQueue, AuditLogger } from '@clad/core'
import type { ApprovalRecord } from '@clad/core'

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function timeUntil(isoString: string): string {
  const diff = new Date(isoString).getTime() - Date.now()
  if (diff <= 0) return 'expired'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function statusBadge(status: ApprovalRecord['status']): string {
  switch (status) {
    case 'pending': return '🟡 pending'
    case 'approved': return '🟢 approved'
    case 'denied': return '🔴 denied'
    case 'expired': return '⚫ expired'
  }
}

function printApproval(r: ApprovalRecord, showDetails = false): void {
  console.log(`  ID:      ${r.id}`)
  console.log(`  Agent:   ${r.agent_id}`)
  console.log(`  Tool:    ${r.tool_name}`)
  console.log(`  Reason:  ${r.trigger_reason}`)
  console.log(`  Status:  ${statusBadge(r.status)}`)
  console.log(`  Created: ${timeAgo(r.created_at)}`)
  if (r.status === 'pending') {
    console.log(`  Expires: in ${timeUntil(r.expires_at)}`)
  }
  if (r.resolved_at) {
    console.log(`  Resolved: ${timeAgo(r.resolved_at)}`)
  }
  if (showDetails) {
    console.log(`  Expires at: ${r.expires_at}`)
  }
  console.log('')
}

function getQueue(): ApprovalQueue | null {
  const config = loadConfig()

  if (!existsSync(config.approval_db)) {
    console.log('No approval queue found. The server creates it on first escalation.')
    return null
  }

  return new ApprovalQueue(config.approval_db)
}

function getAuditLogger(): AuditLogger | null {
  const config = loadConfig()
  if (!existsSync(config.audit_db)) return null
  return new AuditLogger(config.audit_db)
}

export function approvalsListCommand(opts: { all?: boolean; agent?: string } = {}): void {
  const queue = getQueue()
  if (!queue) return

  const filter: { status?: string; agent_id?: string } = {}
  if (!opts.all) filter.status = 'pending'
  if (opts.agent) filter.agent_id = opts.agent

  const records = queue.list(filter)

  if (records.length === 0) {
    const label = opts.all ? '' : 'pending '
    console.log(`No ${label}approvals found.`)
    return
  }

  const label = opts.all ? 'All' : 'Pending'
  console.log(`\n${label} Approvals (${records.length})\n`)
  console.log('─'.repeat(60))

  for (const r of records) {
    printApproval(r)
  }

  if (!opts.all) {
    console.log(`Run: clad approve <id>  or  clad deny <id>`)
    console.log('')
  }
}

export function approveCommand(id: string): void {
  const queue = getQueue()
  if (!queue) return

  try {
    const record = queue.approve(id)
    console.log(`\n✓ Approved: ${record.id}`)
    console.log(`  Agent: ${record.agent_id}  Tool: ${record.tool_name}`)
    console.log(`  The waiting agent will be unblocked on its next status poll.\n`)

    // Record the human decision in the audit log
    const logger = getAuditLogger()
    if (logger) {
      logger.logEscalationDecision(
        record.agent_id,
        record.tool_name,
        'approved',
        'human approved via CLI',
        record.id
      )
    }
  } catch (err) {
    console.error(`✗ Failed to approve: ${err}`)
    process.exit(1)
  }
}

export function denyCommand(id: string): void {
  const queue = getQueue()
  if (!queue) return

  try {
    const record = queue.deny(id)
    console.log(`\n✓ Denied: ${record.id}`)
    console.log(`  Agent: ${record.agent_id}  Tool: ${record.tool_name}\n`)

    // Record the human decision in the audit log
    const logger = getAuditLogger()
    if (logger) {
      logger.logEscalationDecision(
        record.agent_id,
        record.tool_name,
        'denied',
        'human denied via CLI',
        record.id
      )
    }
  } catch (err) {
    console.error(`✗ Failed to deny: ${err}`)
    process.exit(1)
  }
}

export function lockdownCommand(): void {
  const queue = getQueue()
  if (!queue) return

  const pending = queue.listPending()

  if (pending.length === 0) {
    console.log('No pending approvals. Lockdown complete (no active escalations to clear).')
    return
  }

  console.log(`\n⚠️  Lockdown: denying ${pending.length} pending approval${pending.length !== 1 ? 's' : ''}...\n`)

  const logger = getAuditLogger()
  let denied = 0

  for (const r of pending) {
    try {
      queue.deny(r.id)
      console.log(`  ✓ Denied ${r.id}  (${r.agent_id} · ${r.tool_name})`)
      denied++

      // Record each lockdown denial in the audit log
      if (logger) {
        logger.logEscalationDecision(
          r.agent_id,
          r.tool_name,
          'denied',
          'lockdown — all pending escalations denied',
          r.id
        )
      }
    } catch (err) {
      console.log(`  ✗ Could not deny ${r.id}: ${err}`)
    }
  }

  console.log(`\nLockdown complete: ${denied} approval${denied !== 1 ? 's' : ''} denied.`)
  console.log('Note: To prevent new escalations, set spending.enabled: false in your policy.\n')
}
