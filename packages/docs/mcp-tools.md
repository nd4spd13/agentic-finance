# MCP Tools Reference

Clad exposes 5 MCP tools that any MCP-compatible agent can use to interact with financial data. All tools are subject to the policies defined in your `clad.yaml`.

::: danger Field/account-level redaction is not implemented yet (2026-07)
The response examples and **Behavior** notes below describe **target** behavior — `[REDACTED]` fields, `amount_visibility_cap` applied to results, `description_visibility` masking, per-agent account filtering, "all other account details are redacted." **The current code does not do this.** The policy engine makes an allow/deny decision, and both `clad_get_transactions` and `clad_get_balances` then return the provider's **full** objects once a request is allowed (`clad_get_balances` filters only by the optional `account_type` *argument*, not by the agent's `accounts.visible` policy). Field- and account-level shaping of the returned payload is [desktop-app plan **Phase D5.2**](/plans/desktop-app). Treat the redaction described here as the spec D5.2 implements, not as shipped behavior.
:::

## Tool Overview

| Tool | Purpose | Returns |
|------|---------|---------|
| `clad_get_balances` | Fetch account balances | Filtered list of account balances |
| `clad_get_transactions` | Fetch transaction history | Filtered list of transactions |
| `clad_safe_to_spend` | Check available spending | Available balance minus recurring obligations |
| `clad_request_action` | Request a transaction | Allow/Deny/Escalate decision |
| `clad_audit_log` | Fetch decision audit log | List of recent decisions |

## clad_get_balances

Fetch account balances for an agent.

### Parameters

```typescript
interface GetBalancesRequest {
  account_ids?: string[];  // Specific accounts (optional)
  agent_id: string;        // The agent making the request
}
```

### Request Example

```json
{
  "account_ids": ["checking-001", "savings-001"],
  "agent_id": "analyst-agent"
}
```

### Response

```json
{
  "balances": [
    {
      "account_id": "checking-001",
      "account_name": "Business Checking",
      "balance": 45230.50,
      "currency": "USD",
      "last_updated": "2024-03-31T14:30:00Z"
    },
    {
      "account_id": "savings-001",
      "account_name": "Emergency Fund",
      "balance": 150000.00,
      "currency": "USD",
      "last_updated": "2024-03-31T14:30:00Z"
    }
  ],
  "decision": "allow",
  "reason": "Agent has transaction.read permission"
}
```

### Behavior

- ⏳ *(planned, D5.2 — not yet enforced)* Returns only accounts the agent has `visible: true` permission for — today returns all accounts, filtered only by the optional `account_type` argument
- Returns only `balance` field if the agent has `balance: true`
- ⏳ *(planned, D5.2 — not yet enforced)* All other account details are redacted
- If agent lacks any permission, returns `decision: deny`

### Policy Fields

Controlled by:
- `permissions.accounts[].visible`
- `permissions.accounts[].balance`

---

## clad_get_transactions

Fetch transaction history for an account.

### Parameters

```typescript
interface GetTransactionsRequest {
  account_id: string;           // Required: which account
  limit?: number;               // Default: 50, max: 500
  start_date?: string;          // ISO 8601 date (YYYY-MM-DD)
  end_date?: string;            // ISO 8601 date (YYYY-MM-DD)
  agent_id: string;             // The agent making the request
}
```

### Request Example

```json
{
  "account_id": "checking-001",
  "limit": 25,
  "start_date": "2024-03-01",
  "end_date": "2024-03-31",
  "agent_id": "analyst-agent"
}
```

### Response

```json
{
  "transactions": [
    {
      "id": "txn-001",
      "date": "2024-03-31",
      "merchant": "Acme Corp",
      "category": "office-supplies",
      "amount": 250.00,
      "description": "Office supplies purchase",
      "status": "completed",
      "balance_after": 45230.50
    },
    {
      "id": "txn-002",
      "date": "2024-03-30",
      "merchant": "[REDACTED]",
      "category": "[REDACTED]",
      "amount": "[REDACTED]",
      "description": "[REDACTED]",
      "status": "completed",
      "balance_after": "[REDACTED]"
    }
  ],
  "decision": "allow",
  "reason": "Agent has transaction.read permission, applying visibility caps",
  "total_transactions": 127,
  "total_returned": 25
}
```

### Behavior

- Only returns transactions within `lookback_days` window
- ⏳ *(planned, D5.2 — not yet enforced)* Applies `amount_visibility_cap` to amounts above the threshold
- ⏳ *(planned, D5.2 — not yet enforced)* Redacts `description` if `description_visibility: false`
- ⏳ *(planned, D5.2 — not yet enforced)* Returns only merchants/categories visible to the agent based on policy
- Enforces `start_date` and `end_date` within the lookback window

### Policy Fields

Controlled by:
- `permissions.transactions.read`
- `permissions.transactions.amount_visibility_cap`
- `permissions.transactions.description_visibility`
- `permissions.transactions.lookback_days`

---

## clad_safe_to_spend

Check how much an agent can safely spend given their policy limits and existing commitments.

### Parameters

```typescript
interface SafeToSpendRequest {
  account_id: string;     // Required: which account
  agent_id: string;       // The agent making the request
}
```

### Request Example

```json
{
  "account_id": "checking-001",
  "agent_id": "budget-spender"
}
```

### Response

```json
{
  "account_id": "checking-001",
  "account_balance": 45230.50,
  "policy_limits": {
    "max_per_transaction": 1000,
    "max_daily": 5000,
    "max_daily_remaining": 3500,
    "max_weekly": 20000,
    "max_weekly_remaining": 15000,
    "max_monthly": 100000,
    "max_monthly_remaining": 75000
  },
  "committed": {
    "recurring_charges": 200.00,
    "pending_approvals": 500.00,
    "total": 700.00
  },
  "safe_to_spend": 3500.00,
  "recommendation": "Safe to spend up to $3,500.00 today",
  "decision": "allow",
  "reason": "Agent has spending permission"
}
```

### Behavior

- Calculates remaining budget for current day, week, and month
- Subtracts committed amounts (recurring charges, pending escalations)
- Returns the most restrictive limit as `safe_to_spend`
- Applies policy spending constraints
- Factors in any active schedule restrictions

### Policy Fields

Controlled by:
- `permissions.spending.max_per_transaction`
- `permissions.spending.max_daily`
- `permissions.spending.max_weekly`
- `permissions.spending.max_monthly`
- `permissions.schedule` (if active)

---

## clad_request_action

Request permission to perform an action (usually a transaction). This is the primary tool for enforcing policies.

### Parameters

```typescript
interface RequestActionRequest {
  agent_id: string;        // The agent making the request
  tool_name: string;       // What action: "send_money", "transfer", "payment", etc.
  amount: number;          // Amount in the base currency unit
  merchant?: string;       // Optional: merchant name
  category?: string;       // Optional: transaction category
  account_id?: string;     // Optional: which account
  description?: string;    // Optional: transaction description
}
```

### Request Example

```json
{
  "agent_id": "budget-spender",
  "tool_name": "send_money",
  "amount": 1500.00,
  "merchant": "Acme Corp",
  "category": "office-supplies",
  "account_id": "checking-001",
  "description": "Q1 office supplies order"
}
```

### Response (Allow)

```json
{
  "decision": "allow",
  "reason": "Amount within daily limit, merchant allowed, category allowed",
  "amount": 1500.00,
  "policy_checks": {
    "amount_per_transaction": { "status": "pass", "limit": 5000 },
    "daily_limit": { "status": "pass", "limit": 5000, "remaining": 2500 },
    "merchant_whitelist": { "status": "pass", "merchant": "Acme Corp" },
    "category_whitelist": { "status": "pass", "category": "office-supplies" }
  },
  "timestamp": "2024-03-31T14:35:00Z"
}
```

### Response (Deny)

```json
{
  "decision": "deny",
  "reason": "Merchant 'PayPal' is in the blocked merchant list",
  "amount": 500.00,
  "policy_checks": {
    "merchant_blacklist": { "status": "fail", "reason": "Merchant blocked" }
  },
  "timestamp": "2024-03-31T14:35:00Z"
}
```

### Response (Escalate)

```json
{
  "decision": "escalate",
  "reason": "Amount $2,500.00 exceeds approval threshold of $2,000.00",
  "escalation_id": "esc-00001",
  "amount": 2500.00,
  "merchant": "New Vendor LLC",
  "trigger": "amount_exceeds",
  "policy_checks": {
    "amount_exceeds_threshold": { "status": "escalate", "threshold": 2000 },
    "new_merchant": { "status": "escalate" }
  },
  "escalation_details": {
    "channel": "cli",
    "timeout_seconds": 300,
    "webhook_url": null,
    "can_auto_approve": false
  },
  "timestamp": "2024-03-31T14:35:00Z"
}
```

### Behavior

Checks in this order:
1. **Schedule check**: Is the agent allowed to act right now?
2. **Per-transaction limit**: Is the amount under `max_per_transaction`?
3. **Daily limit**: Does this spend exceed `max_daily`?
4. **Weekly limit**: Does this spend exceed `max_weekly`?
5. **Monthly limit**: Does this spend exceed `max_monthly`?
6. **Merchant control**: Is this merchant allowed/blocked?
7. **Category control**: Is this category allowed/blocked?
8. **Escalation triggers**: Does this request match any escalation triggers?
9. **Global limits**: Does organization-wide spending allow this?

If all checks pass, returns `allow`. If any check fails, returns `deny` or `escalate`.

### Policy Fields

Controlled by:
- All `permissions.spending.*` fields
- `permissions.escalation.*` fields
- `permissions.schedule.*` fields
- `global.max_total_daily_spend`
- `global.max_pending_escalations`

---

## clad_audit_log

Fetch the audit log of decisions made by or for agents.

### Parameters

```typescript
interface AuditLogRequest {
  agent_id?: string;           // Filter by specific agent (optional)
  decision?: 'allow' | 'deny' | 'escalate';  // Filter by decision
  tool_name?: string;          // Filter by tool name
  limit?: number;              // Default: 50, max: 500
  start_date?: string;         // ISO 8601 date (YYYY-MM-DD)
  end_date?: string;           // ISO 8601 date (YYYY-MM-DD)
}
```

### Request Example

```json
{
  "agent_id": "budget-spender",
  "decision": "escalate",
  "limit": 10,
  "start_date": "2024-03-01",
  "end_date": "2024-03-31"
}
```

### Response

```json
{
  "audit_log": [
    {
      "entry_id": "log-00001",
      "timestamp": "2024-03-31T14:35:00Z",
      "agent_id": "budget-spender",
      "tool_name": "send_money",
      "decision": "escalate",
      "amount": 2500.00,
      "merchant": "New Vendor LLC",
      "category": "office-supplies",
      "reason": "Amount exceeds approval threshold",
      "escalation_id": "esc-00001",
      "policy_applied": "budget-spender",
      "chain_hash": "sha256:abc123...",
      "previous_hash": "sha256:def456..."
    },
    {
      "entry_id": "log-00000",
      "timestamp": "2024-03-31T14:30:00Z",
      "agent_id": "budget-spender",
      "tool_name": "send_money",
      "decision": "allow",
      "amount": 450.00,
      "merchant": "Acme Corp",
      "category": "office-supplies",
      "reason": "Amount within daily limit",
      "policy_applied": "budget-spender",
      "chain_hash": "sha256:def456...",
      "previous_hash": "sha256:xyz789..."
    }
  ],
  "total_entries": 247,
  "total_returned": 2,
  "query": {
    "agent_id": "budget-spender",
    "decision": "escalate"
  }
}
```

### Behavior

- Returns audit log entries in reverse chronological order (newest first)
- Each entry includes a chain hash for tamper-evidence
- Redacts sensitive information based on the requester's audit permissions
- If `agent_id` is specified, only returns entries for that agent
- Respects `permissions.audit.log_all_queries` setting

### Policy Fields

Controlled by:
- `permissions.audit.log_all_queries`
- `permissions.audit.log_policy_evaluations`

---

## Error Handling

All tools return structured errors:

```json
{
  "decision": "deny",
  "error": true,
  "error_code": "POLICY_ERROR",
  "error_message": "Agent 'invalid-agent' not found in policy",
  "details": {
    "agent_id": "invalid-agent"
  }
}
```

Common error codes:
- `AGENT_NOT_FOUND`: Agent not defined in policy
- `ACCOUNT_NOT_FOUND`: Account not found in policy
- `ACCOUNT_NOT_VISIBLE`: Agent doesn't have access to this account
- `PERMISSION_DENIED`: Agent lacks required permission
- `POLICY_PARSE_ERROR`: Policy file is invalid
- `SCHEDULE_INACTIVE`: Agent is outside active hours/days

---

## Example Usage

Example agent prompt:

> "What's my available spending budget for today?"

The agent internally uses:
1. `clad_safe_to_spend` to check limits
2. `clad_get_balances` to show account balance
3. Returns the result to the user

Example agent prompt with escalation:

> "Send $3,000 to my new vendor, TechCorp Solutions"

The agent uses:
1. `clad_request_action` with the amount and merchant
2. Policy returns `escalate` (new merchant trigger)
3. Agent informs the user: "This requires human approval. Escalation ID: esc-00042"

::: tip Works with any MCP-compatible agent
These tools are available to any agent that speaks MCP — Claude Desktop, OpenAI-based agents, or custom toolchains. The agent identity is determined by the `agent_id` in the request, which is matched against your policy.
:::

## Next Steps

- **[Policy Reference](/policy-reference)**: Understand what each policy field does
- **[Integration Guide](/integration-guides)**: Connect your MCP agent
- **[Starter Policies](/starter-policies)**: Copy ready-to-use policy templates
