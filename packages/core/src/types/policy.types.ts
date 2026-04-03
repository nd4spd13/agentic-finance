// Copyright 2024 CRSPY Inc.
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE in the
// repository root for the full license text.

export interface PolicyConfig {
  agents: Record<string, AgentPolicy>
  global?: GlobalPolicy
}

export interface AgentPolicy {
  description: string
  permissions: AgentPermissions
}

export interface AgentPermissions {
  accounts?: AccountPermissions
  transactions?: TransactionPermissions
  spending?: SpendingPermissions
  escalation?: EscalationConfig
  schedule?: ScheduleConfig
  audit?: AuditConfig
}

export interface AccountPermissions {
  visible: string[]
  balance?: boolean
  account_number?: boolean
  routing_number?: boolean
}

export interface TransactionPermissions {
  read: boolean
  amount_visibility_cap?: number
  description_visibility?: boolean
  lookback_days?: number
}

export interface SpendingPermissions {
  max_per_transaction?: number
  max_daily?: number
  max_weekly?: number
  max_monthly?: number
  merchants?: {
    allow?: string[]
    block?: string[]
  }
  categories?: {
    allow?: string[]
    block?: string[]
  }
  require_itemization?: boolean
}

export interface EscalationConfig {
  triggers: EscalationTrigger[]
  channel: 'cli' | 'webhook'
  timeout: string
  default_on_timeout: 'deny' | 'allow'
}

export type EscalationTrigger =
  | { amount_exceeds: number }
  | { new_merchant: boolean }
  | { new_category: boolean }
  | { category: string[] }
  | { merchant: string[] }
  | { daily_spend_exceeds_pct: number }

export interface ScheduleConfig {
  active_hours?: string
  active_days?: string[]
  timezone?: string
  blackout_dates?: string[]
  behavior_outside_schedule?: 'deny' | 'escalate'
}

export interface AuditConfig {
  log_all_queries?: boolean
  log_policy_evaluations?: boolean
  retention?: string
}

export interface GlobalPolicy {
  max_total_daily_spend?: number
  max_total_weekly_spend?: number
  max_total_monthly_spend?: number
  max_concurrent_agents?: number
  max_pending_escalations?: number
  global_blocked_categories?: string[]
  global_blocked_merchants?: string[]
}
