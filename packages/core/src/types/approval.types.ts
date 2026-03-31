export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface ApprovalRecord {
  id: string
  agent_id: string
  tool_name: string
  trigger_reason: string
  status: ApprovalStatus
  created_at: string
  expires_at: string
  resolved_at?: string
}
