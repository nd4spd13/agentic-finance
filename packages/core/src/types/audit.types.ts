export type AuditEventType = 'request' | 'action' | 'policy_evaluation'

export interface AuditRecord {
  id: string
  timestamp: string
  agent_id: string
  event_type: AuditEventType
  tool_name?: string
  decision?: 'allow' | 'deny' | 'escalate'
  reason?: string
  payload?: string
  receipt_hash: string
  previous_hash: string
}
