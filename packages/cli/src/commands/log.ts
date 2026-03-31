/**
 * clad log — view and export the audit trail
 */

import { existsSync, writeFileSync } from 'node:fs'
import { loadConfig } from '../config.js'
import { AuditLogger } from '@clad/core'
import type { AuditRecord } from '@clad/core'

function formatRecord(r: AuditRecord, index: number): string {
  const ts = new Date(r.timestamp).toLocaleString()
  const decision = r.decision ? ` [${r.decision.toUpperCase()}]` : ''
  const tool = r.tool_name ? ` · ${r.tool_name}` : ''
  return `  ${String(index + 1).padStart(4)}  ${ts}  ${r.agent_id}${tool}${decision}\n        ${r.reason ?? ''}`
}

export interface LogOptions {
  agent?: string
  decision?: string
  tool?: string
  since?: string
  until?: string
  limit?: number
  json?: boolean
}

export function logCommand(opts: LogOptions = {}): void {
  const config = loadConfig()

  if (!existsSync(config.audit_db)) {
    console.log('No audit log found. Start the server and run some requests first.')
    return
  }

  const logger = new AuditLogger(config.audit_db)

  const filters: Parameters<typeof logger.getRecords>[0] = {}
  if (opts.agent) filters.agent_id = opts.agent
  if (opts.decision) filters.decision = opts.decision
  if (opts.tool) filters.tool_name = opts.tool
  if (opts.since) filters.start_time = new Date(opts.since)
  if (opts.until) filters.end_time = new Date(opts.until)

  let records = logger.getRecords(filters)

  if (opts.limit && opts.limit > 0) {
    records = records.slice(-opts.limit)
  }

  if (records.length === 0) {
    console.log('No audit records match the given filters.')
    return
  }

  if (opts.json) {
    console.log(JSON.stringify(records, null, 2))
    return
  }

  console.log(`\nAudit Log (${records.length} record${records.length !== 1 ? 's' : ''})\n`)
  console.log('  #     Timestamp              Agent · Tool                  Decision')
  console.log('  ' + '─'.repeat(72))

  for (let i = 0; i < records.length; i++) {
    console.log(formatRecord(records[i], i))
  }
  console.log('')
}

export function logExportCommand(outputFile: string, opts: LogOptions = {}): void {
  const config = loadConfig()

  if (!existsSync(config.audit_db)) {
    console.error('No audit log found.')
    process.exit(1)
  }

  const logger = new AuditLogger(config.audit_db)

  const filters: Parameters<typeof logger.getRecords>[0] = {}
  if (opts.agent) filters.agent_id = opts.agent
  if (opts.decision) filters.decision = opts.decision
  if (opts.tool) filters.tool_name = opts.tool
  if (opts.since) filters.start_time = new Date(opts.since)
  if (opts.until) filters.end_time = new Date(opts.until)

  const records = logger.getRecords(filters)

  const isCsv = outputFile.endsWith('.csv')

  if (isCsv) {
    const header = 'id,timestamp,agent_id,event_type,tool_name,decision,reason,receipt_hash,previous_hash'
    const rows = records.map(r =>
      [
        r.id,
        r.timestamp,
        r.agent_id,
        r.event_type,
        r.tool_name ?? '',
        r.decision ?? '',
        (r.reason ?? '').replace(/,/g, ';'),
        r.receipt_hash,
        r.previous_hash,
      ].join(',')
    )
    writeFileSync(outputFile, [header, ...rows].join('\n') + '\n', 'utf-8')
  } else {
    writeFileSync(outputFile, JSON.stringify(records, null, 2) + '\n', 'utf-8')
  }

  console.log(`✓ Exported ${records.length} records to ${outputFile}`)
}
