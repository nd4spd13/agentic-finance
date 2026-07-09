/**
 * clad status — show server and policy status
 */

import { existsSync, readFileSync } from 'node:fs'
import { loadConfig, type CladConfig } from '../config.js'
import { AuditLogger, ApprovalQueue, SqliteTokenStore, parsePolicy } from '@clad/core'

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

  console.log('\n🛡️  Clad Status\n')

  // Server status
  let serverStatus = 'stopped'
  let serverPid: number | null = null
  console.log(`[debug] checking PID file: ${config.server_pid_file}`)
  if (existsSync(config.server_pid_file)) {
    const pidStr = readFileSync(config.server_pid_file, 'utf-8').trim()
    const pid = parseInt(pidStr, 10)
    console.log(`[debug] PID file found, contents: "${pidStr}", parsed PID: ${pid}`)
    if (!isNaN(pid) && isRunning(pid)) {
      serverStatus = 'running'
      serverPid = pid
      console.log(`[debug] process ${pid} is alive → running`)
    } else {
      console.log(`[debug] process ${pid} is NOT alive → stopped (stale PID file)`)
    }
  } else {
    console.log(`[debug] PID file does not exist → stopped`)
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
    console.log(`          Run: clad init`)
  }

  // Pending approvals
  if (existsSync(config.approval_db)) {
    try {
      const queue = new ApprovalQueue(config.approval_db)
      const pending = queue.listPending()
      const pendingCount = pending.length
      if (pendingCount > 0) {
        console.log(`\nApprovals: ⚠  ${pendingCount} pending`)
        console.log(`           Run: clad approvals`)
      } else {
        console.log(`Approvals: ✓ none pending`)
      }
    } catch (err) {
      console.log(`Approvals: (db error: ${err instanceof Error ? err.message : String(err)})`)
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
    } catch (err) {
      console.log(`Audit log: (db error: ${err instanceof Error ? err.message : String(err)})`)
    }
  } else {
    console.log(`Audit log: (not initialized)`)
  }

  // Connections (linked provider items)
  console.log('')
  printConnections(config)

  console.log('')
}

/**
 * Lists linked items per provider token store (Plaid / SimpleFIN), if any DB
 * file exists. `SqliteTokenStore.listItems()` returns metadata only — never
 * token/access-URL material — so this is safe to print in full. Opening a
 * store still requires the passphrase that encrypts it (constructor-enforced
 * by `SqliteTokenStore`), so without `CLAD_TOKEN_PASSPHRASE` set this only
 * reports that a store exists, not its contents.
 */
function printConnections(config: CladConfig): void {
  const stores: Array<{ label: string; dbPath: string }> = [
    { label: 'plaid', dbPath: config.plaid_db },
    { label: 'simplefin', dbPath: config.simplefin_db },
  ]
  const existing = stores.filter((s) => existsSync(s.dbPath))

  if (existing.length === 0) {
    console.log('Connections: none linked yet — run `clad connect`')
    return
  }

  const passphrase = process.env.CLAD_TOKEN_PASSPHRASE
  console.log('Connections:')
  for (const { label, dbPath } of existing) {
    if (!passphrase) {
      console.log(`  ${label}: linked (set CLAD_TOKEN_PASSPHRASE to view details)`)
      continue
    }
    let store: SqliteTokenStore
    try {
      store = new SqliteTokenStore({ dbPath, passphrase })
    } catch (err) {
      console.log(`  ${label}: (could not open token store: ${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    try {
      const items = store.listItems()
      if (items.length === 0) {
        console.log(`  ${label}: no items`)
      } else {
        console.log(`  ${label}: ${items.length} item${items.length !== 1 ? 's' : ''}`)
        for (const item of items) {
          console.log(`    - ${item.itemId} (${item.institutionName}) — linked ${item.createdAt}`)
        }
      }
    } finally {
      store.close()
    }
  }
}
