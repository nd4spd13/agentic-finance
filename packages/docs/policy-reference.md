# Policy Reference

Clad policies are written in YAML. This reference documents every field available in a Clad policy.

::: tip Applying policy changes
Edits saved in the desktop app's Policy Editor apply immediately — saving automatically restarts the supervised MCP server, and the editor shows a confirmation. If you edit the YAML by hand (or via `clad ui`), restart the running MCP server for changes to take effect.
:::

## Policy Structure

A Clad policy has two top-level sections:

```yaml
agents:
  agent-name:
    description: string
    permissions: AgentPermissions

global:
  max_total_daily_spend: number
  max_total_weekly_spend: number
  max_total_monthly_spend: number
  max_concurrent_agents: number
  max_pending_escalations: number
  global_blocked_categories: string[]
  global_blocked_merchants: string[]
```

## TypeScript Interfaces

Here are the TypeScript interfaces that define the policy structure:

```typescript
interface PolicyConfig {
  agents: Record<string, AgentPolicy>;
  global?: GlobalPolicy;
}

interface AgentPolicy {
  description: string;
  permissions: AgentPermissions;
}

interface AgentPermissions {
  accounts?: AccountPermissions;
  transactions?: TransactionPermissions;
  spending?: SpendingPermissions;
  escalation?: EscalationConfig;
  schedule?: ScheduleConfig;
  audit?: AuditConfig;
}

interface AccountPermissions {
  visible: string[];
  balance?: boolean;
  account_number?: boolean;
  name?: boolean;
  institution?: boolean;
}

interface TransactionPermissions {
  read: boolean;
  amount_visibility_cap?: number;
  description_visibility?: boolean;
  lookback_days?: number;
}

interface SpendingPermissions {
  max_per_transaction?: number;
  max_daily?: number;
  max_weekly?: number;
  max_monthly?: number;
  merchants?: {
    allow?: string[];
    block?: string[];
  };
  categories?: {
    allow?: string[];
    block?: string[];
  };
  require_itemization?: boolean;
}

interface EscalationConfig {
  triggers: EscalationTrigger[];
  channel: 'cli' | 'webhook';
  timeout: string;                              // Duration string, e.g. "5m", "1h"
  default_on_timeout: 'deny' | 'allow';
}

type EscalationTrigger =
  | { amount_exceeds: number }
  | { new_merchant: boolean }
  | { new_category: boolean }
  | { category: string[] }                      // Array of category names
  | { merchant: string[] }                      // Array of merchant names
  | { daily_spend_exceeds_pct: number };

interface ScheduleConfig {
  active_hours?: string;                        // "HH:MM-HH:MM" format
  active_days?: string[];                       // Lowercase: "monday", "tuesday", etc.
  timezone?: string;
  blackout_dates?: string[];
  behavior_outside_schedule?: 'deny' | 'escalate';
}

interface AuditConfig {
  log_all_queries?: boolean;
  log_policy_evaluations?: boolean;
  retention?: string;                           // Duration string, e.g. "90d", "1y"
}

interface GlobalPolicy {
  max_total_daily_spend?: number;
  max_total_weekly_spend?: number;
  max_total_monthly_spend?: number;
  max_concurrent_agents?: number;
  max_pending_escalations?: number;
  global_blocked_categories?: string[];
  global_blocked_merchants?: string[];
}
```

## Agents Section

The `agents` section defines all agents that can use Clad. Each agent has a unique name.

### AgentPolicy

**`description`** (required, string)
A human-readable description of this agent's role and purpose.

```yaml
agents:
  analyst-agent:
    description: "Financial analyst with read-only access to transaction history"
```

**`permissions`** (required, AgentPermissions)
See the [Permissions Section](#permissions-section) below.

## Permissions Section

The `permissions` object defines what an agent can and cannot do.

### AccountPermissions

Controls which accounts this agent can access and what data is visible.

**`visible`** (required, string[])
List of account IDs or types the agent can see. Each entry can be:
- A specific account ID (e.g., `checking-001`)
- An account type (e.g., `checking`, `savings`)
- An empty array `[]` means all accounts are visible

Accounts not listed here are hidden from the agent. Visible-list enforcement applies to all account operations: balance queries, transaction lookups, and spending checks.

```yaml
permissions:
  accounts:
    visible: [checking-001, savings-001]
    balance: true
```

**`balance`** (boolean, default: false)
Whether the agent can view account balances.

**`account_number`** (boolean, default: false)
Whether the agent can see the masked account number (last 4 digits) in responses.

**`name`** (boolean, default: true)
Whether the agent can see the account name (e.g., "Business Checking").

**`institution`** (boolean, default: true)
Whether the agent can see the institution name (e.g., "Example Bank").

### TransactionPermissions

Controls what transaction data the agent can access.

**`read`** (required, boolean)
Whether the agent can read transaction history at all.

```yaml
permissions:
  transactions:
    read: true
    amount_visibility_cap: 10000
    lookback_days: 30
```

**`amount_visibility_cap`** (number, optional)
Cap the amount field returned in transactions. Useful for read-only agents.

- Omitted: Return full amount
- `5000`: Only return amounts for transactions under $5,000; cap larger amounts as `[REDACTED]`

**`description_visibility`** (boolean, default: true)
Whether descriptions/merchant names are visible in transaction results.

**`lookback_days`** (number, default: 90)
How many days of history the agent can access.

### SpendingPermissions

Controls how much and what the agent can spend.

**`max_per_transaction`** (number, optional)
Maximum amount for a single transaction.

```yaml
spending:
  max_per_transaction: 1000
```

**`max_daily`** (number, optional)
Maximum cumulative spending per calendar day.

**`max_weekly`** (number, optional)
Maximum cumulative spending per calendar week (Monday-Sunday).

**`max_monthly`** (number, optional)
Maximum cumulative spending per calendar month.

**`merchants`** (MerchantControl)
Control spending by merchant.

```yaml
spending:
  merchants:
    allow: []          # Empty = all merchants allowed (unless blocked)
    block:
      - "international-transfer"
      - "high-risk-vendor"
```

- `allow`: Whitelist of merchants. If non-empty, ONLY these merchants are allowed.
- `block`: Blacklist of merchants. These are always denied.

**`categories`** (CategoryControl)
Control spending by category (e.g., "office-supplies", "software", "travel").

```yaml
spending:
  categories:
    allow:
      - office-supplies
      - software-licenses
    block:
      - entertainment
```

- `allow`: Whitelist of categories. If non-empty, ONLY these categories are allowed.
- `block`: Blacklist of categories. These are always denied.

**`require_itemization`** (boolean, default: false)
If `true`, transactions above a threshold must include an itemized description.

### EscalationConfig

Defines when and how decisions escalate to humans.

**`triggers`** (required, EscalationTrigger[])
Array of conditions that trigger escalation.

```yaml
escalation:
  triggers:
    - amount_exceeds: 5000
    - new_merchant: true
    - category: [sensitive-category]
    - daily_spend_exceeds_pct: 80
```

#### EscalationTrigger Fields

Each trigger is a single-key object. Only one field per trigger entry.

**`amount_exceeds`** (number)
Escalate if transaction amount exceeds this value.

**`new_merchant`** (boolean)
Escalate if the merchant hasn't been used by this agent before.

**`new_category`** (boolean)
Escalate if the category hasn't been used by this agent before.

**`category`** (string[])
Escalate for any transaction in these categories.

**`merchant`** (string[])
Escalate for any transaction to these merchants.

**`daily_spend_exceeds_pct`** (number 0-100)
Escalate if today's spending exceeds this percentage of the daily limit. For example, `80` means escalate when 80% of the daily limit is used.

**`channel`** (required, 'cli' | 'webhook')
How escalations are delivered.

- `cli`: Escalation appears in `clad escalate` and requires human approval via CLI
- `webhook`: HTTP POST to `webhook_url` with escalation details

**`webhook_url`** (string, required if channel is 'webhook')
The HTTP endpoint to POST escalations to.

```yaml
escalation:
  channel: webhook
  webhook_url: "https://example.com/clad/escalate"
```

**`timeout`** (required, string)
Duration to wait for human approval, as a duration string (e.g., `"5m"`, `"1h"`, `"30s"`). After this time, `default_on_timeout` applies.

**`default_on_timeout`** (required, 'allow' | 'deny')
What to do if the timeout is reached without a decision.

- `allow`: Auto-approve and proceed
- `deny`: Auto-deny and reject

### ScheduleConfig

Restrict agent access to specific hours and days.

**`active_hours`** (string)
Time window in `"HH:MM-HH:MM"` format (24-hour, local timezone).

```yaml
schedule:
  active_hours: "09:00-17:00"
  timezone: "America/New_York"
```

**`active_days`** (string[])
List of days the agent can act. Use lowercase weekday names.

```yaml
active_days: [monday, tuesday, wednesday, thursday, friday]
```

**`timezone`** (string)
IANA timezone for schedule calculations. Examples: "America/New_York", "Europe/London", "Asia/Tokyo".

**`blackout_dates`** (string[])
Dates the agent cannot act, in YYYY-MM-DD format.

```yaml
blackout_dates:
  - "2024-12-25"  # Christmas
  - "2024-01-01"  # New Year
```

**`behavior_outside_schedule`** (string, default: 'deny')
What to do if a request comes outside active hours/days.

- `deny`: Reject the request
- `escalate`: Send to escalation queue

### AuditConfig

Controls audit logging behavior for this agent.

**`log_all_queries`** (boolean, optional)
Log every data access by this agent.

**`log_policy_evaluations`** (boolean, optional)
Log detailed policy evaluation results.

**`retention`** (string, optional)
How long to retain audit logs as a duration string (e.g., `"90d"`, `"1y"`).

## Global Policy

The optional `global` section sets organization-wide limits.

**`max_total_daily_spend`** (number)
Maximum total spending across all agents in a calendar day.

```yaml
global:
  max_total_daily_spend: 1000000  # $1M/day across all agents
```

**`max_total_weekly_spend`** (number)
Maximum total spending across all agents in a calendar week.

**`max_total_monthly_spend`** (number)
Maximum total spending across all agents in a calendar month.

**`max_concurrent_agents`** (number)
Maximum number of agents that can make concurrent requests.

**`max_pending_escalations`** (number)
Maximum number of pending escalation approvals. New requests are denied when this limit is reached.

**`global_blocked_categories`** (string[])
Categories blocked globally regardless of individual agent policy.

**`global_blocked_merchants`** (string[])
Merchants blocked globally regardless of individual agent policy.

## Complete Example Policy

Here's a realistic policy with all major features:

```yaml
agents:
  read-only-analyst:
    description: "Financial analyst with read-only access"
    permissions:
      accounts:
        visible: [bank-checking-001]
        balance: true
        account_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 90
      audit:
        log_all_queries: true
        log_policy_evaluations: false
        retention: "90d"

  budget-spender:
    description: "Spender with daily limits and merchant controls"
    permissions:
      accounts:
        visible: [corporate-card-001]
        balance: true
      transactions:
        read: true
        lookback_days: 30
      spending:
        max_per_transaction: 500
        max_daily: 2000
        max_weekly: 8000
        merchants:
          block:
            - crypto-exchange
            - high-risk-merchant
        categories:
          allow:
            - office-supplies
            - software-licenses
            - travel
          block:
            - entertainment
      escalation:
        triggers:
          - amount_exceeds: 1000
          - new_merchant: true
          - daily_spend_exceeds_pct: 75
        channel: cli
        timeout: "5m"
        default_on_timeout: deny

  full-featured:
    description: "Fully configured agent with all features"
    permissions:
      accounts:
        visible: [account-001]
        balance: true
        account_number: true
      transactions:
        read: true
        amount_visibility_cap: 50000
        lookback_days: 180
      spending:
        max_per_transaction: 10000
        max_daily: 50000
        max_weekly: 100000
        max_monthly: 500000
        require_itemization: true
      escalation:
        triggers:
          - amount_exceeds: 25000
          - new_merchant: true
          - category: [sensitive-category]
        channel: webhook
        timeout: "10m"
        default_on_timeout: deny
      schedule:
        active_hours: "08:00-18:00"
        active_days: [monday, tuesday, wednesday, thursday, friday]
        timezone: "America/New_York"
        blackout_dates:
          - "2024-12-25"
          - "2024-12-31"
          - "2024-01-01"
        behavior_outside_schedule: escalate
      audit:
        log_all_queries: true
        log_policy_evaluations: true
        retention: "1y"

global:
  max_total_daily_spend: 1000000
  max_total_weekly_spend: 4000000
  max_total_monthly_spend: 15000000
  max_concurrent_agents: 10
  max_pending_escalations: 25
```

## Best Practices

1. **Default-deny model**: Explicitly whitelist what agents can do, rather than blacklisting what they can't.

2. **Escalation overrides limits**: If an escalation is approved by a human, it can exceed normal limits.

3. **Use merchant/category controls**: These are more flexible than flat spending limits.

4. **Monitor the audit log**: Regularly review audit logs to detect unusual patterns.

5. **Version your policies**: Keep `clad.yaml` in version control and review policy changes like code reviews.

6. **Set reasonable timeouts**: Long timeouts delay decisions; short timeouts might auto-deny important requests.

7. **Test escalations**: Regularly test your escalation workflows to ensure humans can approve in time.

8. **Rotate agents**: Create separate agents for different roles rather than one powerful agent.

## Next Steps

- **[Getting Started](/getting-started)**: Set up Clad
- **[MCP Tools](/mcp-tools)**: See what Claude can do with these policies
- **[Starter Policies](/starter-policies)**: Copy ready-to-use templates
