import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import type { AuditRecord } from '../types/index.js'

interface AuditRow {
  id: string
  timestamp: string
  agent_id: string
  event_type: string
  tool_name: string
  decision: string
  reason: string
  payload: string
  receipt_hash: string
  previous_hash: string
}

const GENESIS_HASH = '0'.repeat(64)

export class AuditLogger {
  private db: DatabaseSync
  private lastHash: string = GENESIS_HASH

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_records (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        tool_name TEXT,
        decision TEXT,
        reason TEXT,
        payload TEXT,
        receipt_hash TEXT NOT NULL,
        previous_hash TEXT NOT NULL
      )
    `)

    // Load the last hash from the database if records exist
    const stmt = this.db.prepare('SELECT receipt_hash FROM audit_records ORDER BY timestamp DESC LIMIT 1')
    const lastRecord = stmt.get()
    if (lastRecord) {
      this.lastHash = (lastRecord as { receipt_hash: string }).receipt_hash
    }
  }

  logRequest(
    agent_id: string,
    tool_name: string,
    decision: string,
    reason: string
  ): AuditRecord {
    const id = nanoid()
    const timestamp = new Date().toISOString()
    const event_type = 'request'

    // Compute receipt hash: SHA-256 of all fields + previous hash
    const receiptHash = this.computeHash(
      id,
      timestamp,
      agent_id,
      event_type,
      tool_name,
      decision,
      reason,
      this.lastHash
    )

    const record: AuditRecord = {
      id,
      timestamp,
      agent_id,
      event_type,
      tool_name,
      decision: decision as 'allow' | 'deny' | 'escalate',
      reason,
      receipt_hash: receiptHash,
      previous_hash: this.lastHash,
    }

    // Insert into database
    const stmt = this.db.prepare(`
      INSERT INTO audit_records (
        id, timestamp, agent_id, event_type, tool_name, decision, reason, receipt_hash, previous_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.id,
      record.timestamp,
      record.agent_id,
      record.event_type,
      record.tool_name || '',
      record.decision || '',
      record.reason || '',
      record.receipt_hash,
      record.previous_hash
    )

    // Update last hash
    this.lastHash = receiptHash

    return record
  }

  logEscalationDecision(
    agent_id: string,
    tool_name: string,
    decision: 'approved' | 'denied',
    reason: string,
    approval_id: string
  ): AuditRecord {
    const id = nanoid()
    const timestamp = new Date().toISOString()
    const event_type = 'escalation_decision'
    const payload = JSON.stringify({ approval_id })

    const receiptHash = this.computeHash(
      id,
      timestamp,
      agent_id,
      event_type,
      tool_name,
      decision,
      reason,
      this.lastHash
    )

    const record: AuditRecord = {
      id,
      timestamp,
      agent_id,
      event_type,
      tool_name,
      decision,
      reason,
      payload,
      receipt_hash: receiptHash,
      previous_hash: this.lastHash,
    }

    const stmt = this.db.prepare(`
      INSERT INTO audit_records (
        id, timestamp, agent_id, event_type, tool_name, decision, reason, payload, receipt_hash, previous_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.id,
      record.timestamp,
      record.agent_id,
      record.event_type,
      record.tool_name || '',
      record.decision || '',
      record.reason || '',
      record.payload || '',
      record.receipt_hash,
      record.previous_hash
    )

    this.lastHash = receiptHash
    return record
  }

  getRecords(filters?: {
    agent_id?: string
    decision?: string
    tool_name?: string
    start_time?: Date
    end_time?: Date
  }): AuditRecord[] {
    let query = 'SELECT * FROM audit_records WHERE 1=1'
    const params: string[] = []

    if (filters?.agent_id) {
      query += ' AND agent_id = ?'
      params.push(filters.agent_id)
    }
    if (filters?.decision) {
      query += ' AND decision = ?'
      params.push(filters.decision)
    }
    if (filters?.tool_name) {
      query += ' AND tool_name = ?'
      params.push(filters.tool_name)
    }
    if (filters?.start_time) {
      query += ' AND timestamp >= ?'
      params.push(filters.start_time.toISOString())
    }
    if (filters?.end_time) {
      query += ' AND timestamp <= ?'
      params.push(filters.end_time.toISOString())
    }

    query += ' ORDER BY timestamp ASC'

    const stmt = this.db.prepare(query)
    const rows = stmt.all(...params) as unknown as AuditRow[]

    return rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      agent_id: row.agent_id,
      event_type: row.event_type as AuditRecord['event_type'],
      tool_name: row.tool_name || undefined,
      decision: (row.decision || undefined) as AuditRecord['decision'],
      reason: row.reason || undefined,
      payload: row.payload || undefined,
      receipt_hash: row.receipt_hash,
      previous_hash: row.previous_hash,
    }))
  }

  verifyChain(): boolean {
    const records = this.getRecords()

    if (records.length === 0) {
      return true
    }

    let currentPreviousHash = GENESIS_HASH

    for (const record of records) {
      // Verify previous hash
      if (record.previous_hash !== currentPreviousHash) {
        return false
      }

      // Recompute receipt hash
      const computedHash = this.computeHash(
        record.id,
        record.timestamp,
        record.agent_id,
        record.event_type,
        record.tool_name || '',
        record.decision || '',
        record.reason || '',
        record.previous_hash
      )

      if (computedHash !== record.receipt_hash) {
        return false
      }

      currentPreviousHash = record.receipt_hash
    }

    return true
  }

  cleanup(opts: { retention_days: number }): void {
    if (opts.retention_days === 0) {
      // Delete all records
      this.db.exec('DELETE FROM audit_records')
      this.lastHash = GENESIS_HASH
    } else {
      // Delete records older than retention_days
      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - opts.retention_days)
      const stmt = this.db.prepare('DELETE FROM audit_records WHERE timestamp < ?')
      stmt.run(cutoffDate.toISOString())

      // Update lastHash to the last remaining record
      const lastRecordStmt = this.db.prepare('SELECT receipt_hash FROM audit_records ORDER BY timestamp DESC LIMIT 1')
      const lastRecord = lastRecordStmt.get()
      if (lastRecord) {
        this.lastHash = (lastRecord as { receipt_hash: string }).receipt_hash
      } else {
        this.lastHash = GENESIS_HASH
      }
    }
  }

  close(): void {
    this.db.close()
  }

  private computeHash(
    id: string,
    timestamp: string,
    agent_id: string,
    event_type: string,
    tool_name: string,
    decision: string,
    reason: string,
    previous_hash: string
  ): string {
    const data = `${id}${timestamp}${agent_id}${event_type}${tool_name}${decision}${reason}${previous_hash}`
    return createHash('sha256').update(data).digest('hex')
  }
}
