export type PolicyDecision = 'allow' | 'deny' | 'escalate'

export interface PolicyEvaluation {
  decision: PolicyDecision
  reason: string
  policy_rule: string
  standards_ref?: string
  checks_performed: string[]
  constraints_applied: ConstraintRecord[]
}

export interface ConstraintRecord {
  field: string
  value: unknown
  source: 'ap2' | 'nekuda' | 'mcp-oauth' | 'ack' | 'novel'
}
