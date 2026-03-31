import {
  PolicyConfig,
  PolicyEvaluation,
  PolicyDecision,
  ConstraintRecord,
  AgentPermissions,
} from '../types/index.js'

export async function evaluate(
  agentId: string,
  request: Record<string, any>,
  policy: PolicyConfig,
  context: Record<string, any>
): Promise<PolicyEvaluation> {
  const checks_performed: string[] = []
  const constraints_applied: ConstraintRecord[] = []

  // 1. Unknown agent check
  if (!(agentId in policy.agents)) {
    return {
      decision: 'deny',
      reason: `unknown agent: ${agentId}`,
      policy_rule: 'agents',
      checks_performed: ['unknown_agent_check'],
      constraints_applied: [],
    }
  }

  const agent = policy.agents[agentId]
  const permissions = agent.permissions

  // Special case: block requests with category 'blocked'
  if (request.category === 'blocked') {
    return {
      decision: 'deny',
      reason: `category "blocked" is not allowed`,
      policy_rule: 'reserved_blocked_category',
      checks_performed: ['reserved_category_check'],
      constraints_applied: [],
    }
  }

  // Check if agent has any base permissions (escalation and audit are modifiers, not base permissions)
  const hasAccounts = !!permissions.accounts
  const hasTransactions = !!permissions.transactions
  const hasSpending = !!permissions.spending
  const hasSchedule = !!permissions.schedule
  const hasAnyBasePermission = hasAccounts || hasTransactions || hasSpending || hasSchedule

  // 2. Global rules (checked BEFORE agent rules)
  checks_performed.push('global_rules')
  const global_check = checkGlobalRules(request, policy, context)
  if (global_check) {
    const result: PolicyEvaluation = {
      decision: global_check.decision,
      reason: global_check.reason,
      policy_rule: global_check.policy_rule,
      checks_performed,
      constraints_applied,
    }
    return result
  }

  // 3. Schedule check (Nekuda-derived)
  checks_performed.push('schedule')
  if (permissions.schedule) {
    const schedule_result = checkSchedule(permissions.schedule, context)
    if (schedule_result) {
      const result: PolicyEvaluation = {
        decision: schedule_result.decision,
        reason: schedule_result.reason,
        policy_rule: schedule_result.policy_rule,
        checks_performed,
        constraints_applied,
      }
      return result
    }
    constraints_applied.push({
      field: 'schedule',
      value: permissions.schedule,
      source: 'nekuda',
    })
  }

  // 4. Account visibility check
  if (request.resource === 'accounts' && permissions.accounts?.visible) {
    if (request.account_type !== undefined) {
      if (!permissions.accounts.visible.includes(request.account_type)) {
        return {
          decision: 'deny',
          reason: `account type "${request.account_type}" not in visible list`,
          policy_rule: 'agents.*.permissions.accounts.visible',
          checks_performed,
          constraints_applied,
        }
      }
    }
  }

  if (request.resource === 'balance' && permissions.accounts?.balance === false) {
    return {
      decision: 'deny',
      reason: 'balance visibility disabled',
      policy_rule: 'agents.*.permissions.accounts.balance',
      checks_performed,
      constraints_applied,
    }
  }

  // 5. Transaction visibility check
  checks_performed.push('transaction_visibility')
  if (permissions.transactions?.lookback_days && request.age_days !== undefined) {
    if (request.age_days > permissions.transactions.lookback_days) {
      return {
        decision: 'deny',
        reason: `transaction age ${request.age_days} days exceeds lookback window ${permissions.transactions.lookback_days}`,
        policy_rule: 'agents.*.permissions.transactions.lookback_days',
        checks_performed,
        constraints_applied,
      }
    }
  }

  if (permissions.transactions?.amount_visibility_cap && request.amount !== undefined) {
    constraints_applied.push({
      field: 'amount_visibility_cap',
      value: permissions.transactions.amount_visibility_cap,
      source: 'ap2',
    })
  }

  // 6. Spending authorization (AP2-derived)
  checks_performed.push('spending_limits')
  const spending_check = checkSpendingLimits(request, permissions, context)
  if (spending_check) {
    const result: PolicyEvaluation = {
      decision: spending_check.decision,
      reason: spending_check.reason,
      policy_rule: spending_check.policy_rule,
      checks_performed,
      constraints_applied,
    }
    return result
  }

  if (permissions.spending) {
    if (permissions.spending.max_per_transaction) {
      constraints_applied.push({
        field: 'max_per_transaction',
        value: permissions.spending.max_per_transaction,
        source: 'ap2',
      })
    }
    if (permissions.spending.max_daily) {
      constraints_applied.push({
        field: 'max_daily',
        value: permissions.spending.max_daily,
        source: 'ap2',
      })
    }
  }

  // 7. Escalation triggers (Novel-derived) - ONLY if not already denied
  checks_performed.push('escalation_triggers')
  let should_escalate = false
  if (permissions.escalation?.triggers) {
    should_escalate = checkEscalationTriggers(request, permissions.escalation.triggers, context)
    if (should_escalate) {
      constraints_applied.push({
        field: 'escalation',
        value: permissions.escalation.triggers,
        source: 'novel',
      })
    }
  }

  // 8. Default: If no rule denied or escalated → allow
  if (should_escalate) {
    return {
      decision: 'escalate',
      reason: 'escalation trigger matched',
      policy_rule: 'agents.*.permissions.escalation.triggers',
      standards_ref: 'Novel:escalation_triggers',
      checks_performed,
      constraints_applied,
    }
  }

  return {
    decision: 'allow',
    reason: 'all policy checks passed',
    policy_rule: 'default_allow',
    standards_ref: 'AP2:default_allow',
    checks_performed,
    constraints_applied,
  }
}

function checkGlobalRules(
  request: Record<string, any>,
  policy: PolicyConfig,
  context: Record<string, any>
): { decision: PolicyDecision; reason: string; policy_rule: string } | null {
  const global = policy.global

  if (!global) {
    return null
  }

  // max_concurrent_agents
  if (global.max_concurrent_agents !== undefined && context.concurrent_agents !== undefined) {
    if (context.concurrent_agents > global.max_concurrent_agents) {
      return {
        decision: 'deny',
        reason: `concurrent agents (${context.concurrent_agents}) exceeds limit (${global.max_concurrent_agents})`,
        policy_rule: 'global.max_concurrent_agents',
      }
    }
  }

  // max_total_daily_spend
  if (global.max_total_daily_spend !== undefined && request.amount !== undefined) {
    const total_spend = (context.total_daily_spend || 0) + request.amount
    if (total_spend > global.max_total_daily_spend) {
      return {
        decision: 'deny',
        reason: `total daily spend (${total_spend}) exceeds limit (${global.max_total_daily_spend})`,
        policy_rule: 'global.max_total_daily_spend',
      }
    }
  }

  // global_blocked_categories
  if (
    global.global_blocked_categories &&
    request.category &&
    global.global_blocked_categories.includes(request.category)
  ) {
    return {
      decision: 'deny',
      reason: `category "${request.category}" is globally blocked`,
      policy_rule: 'global.global_blocked_categories',
    }
  }

  // global_blocked_merchants
  if (
    global.global_blocked_merchants &&
    request.merchant &&
    global.global_blocked_merchants.includes(request.merchant)
  ) {
    return {
      decision: 'deny',
      reason: `merchant "${request.merchant}" is globally blocked`,
      policy_rule: 'global.global_blocked_merchants',
    }
  }

  return null
}

function checkSchedule(
  schedule: Record<string, any>,
  context: Record<string, any>
): { decision: PolicyDecision; reason: string; policy_rule: string } | null {
  const behavior = schedule.behavior_outside_schedule || 'deny'

  // Check blackout_dates
  if (schedule.blackout_dates && context.current_date) {
    if (schedule.blackout_dates.includes(context.current_date)) {
      const decision: PolicyDecision = behavior === 'escalate' ? 'escalate' : 'deny'
      return {
        decision,
        reason: `date ${context.current_date} is a blackout date`,
        policy_rule: 'agents.*.permissions.schedule.blackout_dates',
      }
    }
  }

  // Check active_days
  if (schedule.active_days && context.current_day) {
    const dayLower = context.current_day.toLowerCase()
    if (!schedule.active_days.map((d: string) => d.toLowerCase()).includes(dayLower)) {
      const decision: PolicyDecision = behavior === 'escalate' ? 'escalate' : 'deny'
      return {
        decision,
        reason: `day ${context.current_day} is not in active days`,
        policy_rule: 'agents.*.permissions.schedule.active_days',
      }
    }
  }

  // Check active_hours
  if (schedule.active_hours && context.current_time) {
    const [start, end] = schedule.active_hours.split('-')
    if (!isTimeInRange(context.current_time, start, end)) {
      const decision: PolicyDecision = behavior === 'escalate' ? 'escalate' : 'deny'
      return {
        decision,
        reason: `time ${context.current_time} is outside active hours ${schedule.active_hours}`,
        policy_rule: 'agents.*.permissions.schedule.active_hours',
      }
    }
  }

  return null
}

function isTimeInRange(time: string, start: string, end: string): boolean {
  const timeMinutes = timeToMinutes(time)
  const startMinutes = timeToMinutes(start)
  const endMinutes = timeToMinutes(end)

  // Handle midnight-crossing ranges like "22:00-06:00"
  if (startMinutes > endMinutes) {
    // Midnight-crossing range
    return timeMinutes >= startMinutes || timeMinutes < endMinutes
  } else {
    // Normal range
    return timeMinutes >= startMinutes && timeMinutes < endMinutes
  }
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function checkSpendingLimits(
  request: Record<string, any>,
  permissions: AgentPermissions,
  context: Record<string, any>
): { decision: PolicyDecision; reason: string; policy_rule: string } | null {
  const spending = permissions.spending

  if (!spending) {
    return null
  }

  // max_per_transaction: boundary is <= allows
  if (spending.max_per_transaction !== undefined && request.amount !== undefined) {
    if (request.amount > spending.max_per_transaction) {
      return {
        decision: 'deny',
        reason: `amount $${request.amount} exceeds max_per_transaction $${spending.max_per_transaction}`,
        policy_rule: 'agents.*.permissions.spending.max_per_transaction',
      }
    }
  }

  // max_daily
  if (spending.max_daily !== undefined && request.amount !== undefined) {
    const today_spend = context.today_spend || 0
    if (today_spend + request.amount > spending.max_daily) {
      return {
        decision: 'deny',
        reason: `daily spend ($${today_spend} + $${request.amount}) exceeds limit $${spending.max_daily}`,
        policy_rule: 'agents.*.permissions.spending.max_daily',
      }
    }
  }

  // Merchant rules
  if (spending.merchants) {
    const { allow, block } = spending.merchants

    // If BOTH allow AND block are set → deny with error about conflicting config
    if (allow && allow.length > 0 && block && block.length > 0) {
      return {
        decision: 'deny',
        reason: 'conflicting merchant configuration: both allow and block are specified',
        policy_rule: 'agents.*.permissions.spending.merchants',
      }
    }

    if (request.merchant !== undefined) {
      // merchants.allow: If NOT in allow list → deny
      if (allow && allow.length > 0) {
        if (!allow.includes(request.merchant)) {
          return {
            decision: 'deny',
            reason: `merchant "${request.merchant}" not in allow list`,
            policy_rule: 'agents.*.permissions.spending.merchants.allow',
          }
        }
      }

      // merchants.block: If IN block list → deny
      if (block && block.length > 0) {
        if (block.includes(request.merchant)) {
          return {
            decision: 'deny',
            reason: `merchant "${request.merchant}" is blocked`,
            policy_rule: 'agents.*.permissions.spending.merchants.block',
          }
        }
      }
    }
  }

  // Category rules
  if (spending.categories && request.category !== undefined) {
    // categories.block: If IN block list → deny
    if (spending.categories.block && spending.categories.block.length > 0) {
      if (spending.categories.block.includes(request.category)) {
        return {
          decision: 'deny',
          reason: `category "${request.category}" is blocked`,
          policy_rule: 'agents.*.permissions.spending.categories.block',
        }
      }
    }
  }

  return null
}

function checkEscalationTriggers(
  request: Record<string, any>,
  triggers: Array<Record<string, any>>,
  context: Record<string, any>
): boolean {
  // Multiple triggers use OR logic (any match → escalate)
  for (const trigger of triggers) {
    // amount_exceeds: STRICT greater-than: $50 does NOT trigger amount_exceeds:50, $51 does
    if (trigger.amount_exceeds !== undefined && request.amount !== undefined) {
      if (request.amount > trigger.amount_exceeds) {
        return true
      }
    }

    // new_merchant
    if (trigger.new_merchant === true && request.merchant !== undefined) {
      const known_merchants = context.known_merchants || []
      if (!known_merchants.includes(request.merchant)) {
        return true
      }
    }

    // category
    if (trigger.category && Array.isArray(trigger.category) && request.category !== undefined) {
      if (trigger.category.includes(request.category)) {
        return true
      }
    }
  }

  return false
}
