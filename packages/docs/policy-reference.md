# Policy Reference

Guardian Layer policies are written in YAML. This reference documents every field available in a Guardian Layer policy.

## Policy Structure

A Guardian Layer policy has two top-level sections:

```yaml
agents:
  agent-name:
    description: string
    permissions: AgentPermissions

global:
  max_total_daily_spend: number
  max_concurrent_agents: number
```

## TypeScript Interfaces

Here are the TypeScript interfaces that define the policy structure:

```typescript
interface GuardianPolicy {
  agents: Record<string, AgentPolicy>;
  global?: GlobalPolicy;
}

interface AgentPolicy {
  description: string;
  permissions: AgentPermissions;
}

interface AgentPermissions {
  accounts: AccountPermissions[];
  transactions?: TransactionPermissions;
  spending?: SpendingPermissions;
  escalation?: EscalationConfig;
  schedule?: ScheduleConfig;
  audit?: AuditPermissions;
}

interface AccountPermissions {
  id: string;
  visible: boolean;
  balance?: boolean;
  account_number?: boolean;
  routing_number?: boolean;
}

interface TransactionPermissions {
  read: boolean;
  amount_visibility_cap?: number | null;
  description_visibility?: boolean;
  lookback_days?: number;
}

interface SpendingPermissions {
  max_per_transaction?: number | null;
  max_daily?: number | null;
  max_weekly?: number | null;
  max_monthly?: number | null;
  merchants?: MerchantControl;
  categories?: CategoryControl;
  require_itemization?: boolean;
}

interface MerchantControl {
  allow?: string[];
  block?: string[];
}

interface CategoryControl {
  allow?: string[];
  block?: string[];
}

interface EscalationConfig {
  triggers: EscalationTrigger[];
  channel: 'cli' | 'webhook';
  timeout?: number;
  default_on_timeout?: 'allow' | 'deny';
  webhook_url?: string;
}

interface EscalationTrigger {
  amount_exceeds?: number;
  new_merchant?: boolean;
  new_category?: boolean;
  category?: string;
  merchant?: string;
  daily_spend_exceeds_pct?: number;
}

interface ScheduleConfig {
  active_hours?: {
    start: string;
    end: string;
  };
  active_days?: string[];
  timezone?: string;
  blackout_dates?: string[];
  behavior_outside_schedule?: 'deny' | 'escalate' | 'allow';
}

interface AuditPermissions {
  can_view_audit_log: boolean;
  can_view_other_agents: boolean;
}

interface GlobalPolicy {
  max_total_daily_spend?: number;
  max_concurrent_agents?: number;
  require_human_approval_above?: number;
  default_escalation_timeout?: number;
}
```

## Agents Section

The `agents` section defines all agents that can use Guardian Layer. Each agent has a unique name.

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

Array of accounts this agent can access. Each account permission has:

**`id`** (required, string)
The account identifier. Must match an account in your financial system.

```yaml
permissions:
  accounts:
    - id: checking-001
      visible: true
      balance: true
```

**`visible`** (required, boolean)
Whether this agent can see this account listed at all.

- `true`: Account appears in account lists
- `false`: Account is hidden from agent

**`balance`** (boolean, default: false)
Whether the agent can view this account's balance.

**`account_number`** (boolean, default: false)
Whether the agent can view the account number.

**`routing_number`** (boolean, default: false)
Whether the agent can view the routing number.

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

**`amount_visibility_cap`** (number | null, default: null)
Cap the amount field returned in transactions. Useful for read-only agents.

- `null`: Return full amount
- `5000`: Only return amounts for transactions under $5,000; cap larger amounts as `[REDACTED]`

**`description_visibility`** (boolean, default: true)
Whether descriptions/merchant names are visible in transaction results.

**`lookback_days`** (number, default: 90)
How many days of history the agent can access.

### SpendingPermissions

Controls how much and what the agent can spend.

**`max_per_transaction`** (number | null, default: null)
Maximum amount for a single transaction.

```yaml
spending:
  max_per_transaction: 1000
```

**`max_daily`** (number | null, default: null)
Maximum cumulative spending per calendar day.

**`max_weekly`** (number | null, default: null)
Maximum cumulative spending per calendar week (Monday-Sunday).

**`max_monthly`** (number | null, default: null)
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
    - category: sensitive-category
    - daily_spend_exceeds_pct: 80
```

#### EscalationTrigger Fields

**`amount_exceeds`** (number)
Escalate if transaction amount exceeds this value.

**`new_merchant`** (boolean)
Escalate if the merchant hasn't been used by this agent before.

**`new_category`** (boolean)
Escalate if the category hasn't been used by this agent before.

**`category`** (string)
Escalate for any transaction in this category.

**`merchant`** (string)
Escalate for any transaction to this merchant.

**`daily_spend_exceeds_pct`** (number 0-100)
Escalate if today's spending exceeds this percentage of the daily limit. For example, `80` means escalate when 80% of the daily limit is used.

**`channel`** (required, 'cli' | 'webhook')
How escalations are delivered.

- `cli`: Escalation appears in `guardian escalate` and requires human approval via CLI
- `webhook`: HTTP POST to `webhook_url` with escalation details

**`webhook_url`** (string, required if channel is 'webhook')
The HTTP endpoint to POST escalations to.

```yaml
escalation:
  channel: webhook
  webhook_url: "https://example.com/guardian/escalate"
```

**`timeout`** (number, default: 300)
Seconds to wait for human approval. After this time, `default_on_timeout` applies.

**`default_on_timeout`** (string, default: 'deny')
What to do if the timeout is reached without a decision.

- `allow`: Auto-approve and proceed
- `deny`: Auto-deny and reject

### ScheduleConfig

Restrict agent access to specific hours and days.

**`active_hours`** (object)
Define start and end times in HH:MM format (24-hour).

```yaml
schedule:
  active_hours:
    start: "09:00"
    end: "17:00"
  timezone: "America/New_York"
```

**`active_days`** (string[])
List of days the agent can act. Use ISO weekday names.

```yaml
active_days:
  - "Monday"
  - "Tuesday"
  - "Wednesday"
  - "Thursday"
  - "Friday"
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
- `allow`: Allow it anyway

### AuditPermissions

Control what audit log data the agent can view.

**`can_view_audit_log`** (boolean, default: false)
Whether this agent can view its own audit log entries.

**`can_view_other_agents`** (boolean, default: false)
Whether this agent can view audit log entries from other agents. (Requires elevated privileges.)

## Global Policy

The optional `global` section sets organization-wide limits.

**`max_total_daily_spend`** (number)
Maximum total spending across all agents in a calendar day.

```yaml
global:
  max_total_daily_spend: 1000000  # $1M/day across all agents
```

**`max_concurrent_agents`** (number)
Maximum number of agents that can make concurrent requests.

**`require_human_approval_above`** (number)
Any spending decision above this amount (across all agents) must escalate to humans.

**`default_escalation_timeout`** (number)
Default timeout in seconds for escalations (overrideable per agent).

## Complete Example Policy

Here's a realistic policy with all major features:

```yaml
agents:
  read-only-analyst:
    description: "Financial analyst with read-only access"
    permissions:
      accounts:
        - id: bank-checking-001
          visible: true
          balance: true
          account_number: false
          routing_number: false
      transactions:
        read: true
        amount_visibility_cap: null
        description_visibility: true
        lookback_days: 90
      audit:
        can_view_audit_log: true
        can_view_other_agents: false

  budget-spender:
    description: "Spender with daily limits and merchant controls"
    permissions:
      accounts:
        - id: corporate-card-001
          visible: true
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
        timeout: 300
        default_on_timeout: deny

  full-featured:
    description: "Fully configured agent with all features"
    permissions:
      accounts:
        - id: account-001
          visible: true
          balance: true
          account_number: true
          routing_number: false
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
          - category: sensitive-category
        channel: webhook
        webhook_url: "https://internal.example.com/guardian/escalate"
        timeout: 600
        default_on_timeout: deny
      schedule:
        active_hours:
          start: "08:00"
          end: "18:00"
        active_days:
          - "Monday"
          - "Tuesday"
          - "Wednesday"
          - "Thursday"
          - "Friday"
        timezone: "America/New_York"
        blackout_dates:
          - "2024-12-25"
          - "2024-12-31"
          - "2024-01-01"
        behavior_outside_schedule: escalate
      audit:
        can_view_audit_log: true
        can_view_other_agents: false

global:
  max_total_daily_spend: 1000000
  max_concurrent_agents: 10
  require_human_approval_above: 50000
  default_escalation_timeout: 300
```

## Best Practices

1. **Default-deny model**: Explicitly whitelist what agents can do, rather than blacklisting what they can't.

2. **Escalation overrides limits**: If an escalation is approved by a human, it can exceed normal limits.

3. **Use merchant/category controls**: These are more flexible than flat spending limits.

4. **Monitor the audit log**: Regularly review audit logs to detect unusual patterns.

5. **Version your policies**: Keep `guardian.yaml` in version control and review policy changes like code reviews.

6. **Set reasonable timeouts**: Long timeouts delay decisions; short timeouts might auto-deny important requests.

7. **Test escalations**: Regularly test your escalation workflows to ensure humans can approve in time.

8. **Rotate agents**: Create separate agents for different roles rather than one powerful agent.

## Next Steps

- **[Getting Started](/getting-started)**: Set up Guardian Layer
- **[MCP Tools](/mcp-tools)**: See what Claude can do with these policies
- **[Starter Policies](/starter-policies)**: Copy ready-to-use templates
