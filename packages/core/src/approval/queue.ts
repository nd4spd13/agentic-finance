import { DatabaseSync } from 'node:sqlite'
import { nanoid } from 'nanoid'
import type { ApprovalRecord } from '../types/index.js'

export class ApprovalQueue {
  private db: DatabaseSync
  private maxPending: number | undefined

  constructor(dbPath: string, opts?: { max_pending?: number }) {
    this.db = new DatabaseSync(dbPath)
    this.maxPending = opts?.max_pending

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        trigger_reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      )
    `)
  }

  createApproval(
    agent_id: string,
    tool_name: string,
    trigger_reason: string,
    timeout?: string
  ): ApprovalRecord {
    // Check max_pending limit
    if (this.maxPending !== undefined) {
      const stmt = this.db.prepare("SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'")
      const result = stmt.get() as { count: number }
      if (result.count >= this.maxPending) {
        throw new Error(`Maximum pending approvals (${this.maxPending}) reached`)
      }
    }

    const id = nanoid()
    const created_at = new Date().toISOString()

    // Parse timeout (default '15m')
    const timeoutStr = timeout || '15m'
    const expires_at = this.addTimeout(created_at, timeoutStr)

    const record: ApprovalRecord = {
      id,
      agent_id,
      tool_name,
      trigger_reason,
      status: 'pending',
      created_at,
      expires_at,
    }

    const stmt = this.db.prepare(`
      INSERT INTO approvals (
        id, agent_id, tool_name, trigger_reason, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.id,
      record.agent_id,
      record.tool_name,
      record.trigger_reason,
      record.status,
      record.created_at,
      record.expires_at
    )

    return record
  }

  approve(id: string): ApprovalRecord {
    const record = this.get(id)

    if (record.status !== 'pending') {
      throw new Error(`Cannot approve approval with status '${record.status}'`)
    }

    const resolved_at = new Date().toISOString()
    const stmt = this.db.prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?')
    stmt.run('approved', resolved_at, id)

    return {
      ...record,
      status: 'approved',
      resolved_at,
    }
  }

  deny(id: string): ApprovalRecord {
    const record = this.get(id)

    if (record.status !== 'pending') {
      throw new Error(`Cannot deny approval with status '${record.status}'`)
    }

    const resolved_at = new Date().toISOString()
    const stmt = this.db.prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?')
    stmt.run('denied', resolved_at, id)

    return {
      ...record,
      status: 'denied',
      resolved_at,
    }
  }

  get(id: string): ApprovalRecord {
    const stmt = this.db.prepare('SELECT * FROM approvals WHERE id = ?')
    const row = stmt.get(id) as any

    if (!row) {
      throw new Error(`Approval ${id} not found`)
    }

    const record: ApprovalRecord = {
      id: row.id,
      agent_id: row.agent_id,
      tool_name: row.tool_name,
      trigger_reason: row.trigger_reason,
      status: row.status,
      created_at: row.created_at,
      expires_at: row.expires_at,
      resolved_at: row.resolved_at,
    }

    // Auto-expire if pending and past expiry
    if (record.status === 'pending' && new Date() > new Date(record.expires_at)) {
      const updateStmt = this.db.prepare('UPDATE approvals SET status = ? WHERE id = ?')
      updateStmt.run('expired', id)
      record.status = 'expired'
    }

    return record
  }

  listPending(): ApprovalRecord[] {
    return this.list({ status: 'pending' })
  }

  list(filters?: { status?: string; agent_id?: string }): ApprovalRecord[] {
    let query = 'SELECT * FROM approvals WHERE 1=1'
    const params: string[] = []

    if (filters?.status) {
      query += ' AND status = ?'
      params.push(filters.status)
    }
    if (filters?.agent_id) {
      query += ' AND agent_id = ?'
      params.push(filters.agent_id)
    }

    query += ' ORDER BY created_at DESC'

    const stmt = this.db.prepare(query)
    const rows = stmt.all(...params) as any[]

    // Auto-expire pending records that are past their expiry
    const now = new Date()
    return rows.map(row => {
      const record: ApprovalRecord = {
        id: row.id,
        agent_id: row.agent_id,
        tool_name: row.tool_name,
        trigger_reason: row.trigger_reason,
        status: row.status as ApprovalRecord['status'],
        created_at: row.created_at,
        expires_at: row.expires_at,
        resolved_at: row.resolved_at,
      }
      if (record.status === 'pending' && now > new Date(record.expires_at)) {
        const updateStmt = this.db.prepare('UPDATE approvals SET status = ? WHERE id = ?')
        updateStmt.run('expired', row.id)
        record.status = 'expired'
      }
      return record
    })
  }

  private addTimeout(baseTime: string, timeoutStr: string): string {
    const now = new Date(baseTime)

    // Parse timeout string (e.g., '15m', '1h', '5s')
    const match = timeoutStr.match(/^(\d+)(ms|s|m|h)$/)
    if (!match) {
      throw new Error(`Invalid timeout format: ${timeoutStr}`)
    }

    const value = parseInt(match[1], 10)
    const unit = match[2]

    let ms = 0
    switch (unit) {
      case 'ms':
        ms = value
        break
      case 's':
        ms = value * 1000
        break
      case 'm':
        ms = value * 60 * 1000
        break
      case 'h':
        ms = value * 60 * 60 * 1000
        break
    }

    return new Date(now.getTime() + ms).toISOString()
  }
}
