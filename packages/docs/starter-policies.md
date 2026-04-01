# Starter Policy Templates

This page contains three complete, production-ready Clad policy templates you can copy and customize for your use case.

## 1. Read-Only Analyst

**Best for:** Financial analysts, auditors, and read-only access roles.

**Features:**
- Full transaction visibility (no amount caps)
- Can see balances
- Cannot spend money
- No escalations (read operations don't escalate)
- Can view audit logs

**Use case:** An analyst who needs to review historical transactions and current balances but has no spending authority.

```yaml
agents:
  analyst:
    description: "Financial analyst with read-only access"
    permissions:
      accounts:
        visible: [checking-001, savings-001]
        balance: true
        account_number: false
        routing_number: false

      transactions:
        read: true
        description_visibility: true
        lookback_days: 365             # Full year of history

      spending:
        max_per_transaction: 0         # Cannot spend
        max_daily: 0
        require_itemization: false

      audit:
        log_all_queries: true
        log_policy_evaluations: false
        retention: "1y"

global:
  max_concurrent_agents: 5
```

**To use:**
1. Copy this YAML to `clad.yaml`
2. Customize account IDs to match your accounts
3. Run `clad init --file clad.yaml`
4. Test with: `clad status`

**Claude integration:**
> "Show me all transactions from January"
> "What's my current account balance?"
> "How much have I spent on office supplies this year?"

---

## 2. Budget-Aware Spender

**Best for:** Autonomous spending with clear limits. Typical for operational expenses, procurement, or delegated purchasing.

**Features:**
- Limited spending authority: $500/transaction, $2,000/day, $8,000/week
- Merchant blacklist (block high-risk vendors)
- Category whitelist (only office supplies, software, travel)
- Escalation for new merchants and high daily spend
- CLI-based approval for escalations

**Use case:** A team member who needs to make routine purchases (office supplies, software licenses, travel) but shouldn't access high-risk merchants or spend excessively.

```yaml
agents:
  procurement:
    description: "Team member with procurement authority"
    permissions:
      accounts:
        visible: [corporate-card-001]
        balance: true
        account_number: false
        routing_number: false

      transactions:
        read: true
        description_visibility: true
        lookback_days: 90

      spending:
        max_per_transaction: 500
        max_daily: 2000
        max_weekly: 8000
        merchants:
          allow: []
          block:
            - "cryptocurrency-exchange"
            - "high-risk-merchant"
            - "international-transfer"
        categories:
          allow:
            - "office-supplies"
            - "software-licenses"
            - "travel-flights"
            - "travel-hotels"
          block:
            - "entertainment"
            - "bars-restaurants"

      escalation:
        triggers:
          - amount_exceeds: 1000
          - new_merchant: true
          - daily_spend_exceeds_pct: 75
        channel: cli
        timeout: "5m"
        default_on_timeout: deny

      schedule:
        active_hours: "08:00-18:00"
        active_days: [monday, tuesday, wednesday, thursday, friday]
        timezone: "America/New_York"
        behavior_outside_schedule: deny

      audit:
        log_all_queries: true
        log_policy_evaluations: false
        retention: "90d"

global:
  max_total_daily_spend: 50000
  max_concurrent_agents: 10
```

**To use:**
1. Copy this YAML to `clad.yaml`
2. Adjust `max_per_transaction`, `max_daily`, `max_weekly` to your comfort level
3. Update merchant and category lists to match your vendor ecosystem
4. Run `clad reload`
5. Test by asking Claude to make a purchase

**Claude integration:**
> "I need to order $300 of office supplies from Staples"
> "Can I send $800 to AWS for software licensing?"
> "What's my spending budget left for today?"

---

## 3. Full-Featured Agent

**Best for:** Complex scenarios with multiple constraints, escalation to webhooks, and comprehensive audit trails.

**Features:**
- High spending authority: $10,000/transaction, $50,000/day, $100,000/week, $500,000/month
- Requires itemization for large purchases
- Both merchant and category controls
- Webhook-based escalation (for approval routing via email or Slack)
- Active hours enforcement (business hours only)
- Blackout dates (no spending on holidays)
- Full audit log access
- Global organization limits

**Use case:** An autonomous agent with broad spending authority but subject to escalation approval for unusual transactions. Escalations go to a central approval queue.

```yaml
agents:
  autonomous-spender:
    description: "Autonomous agent with broad authority and approval workflow"
    permissions:
      accounts:
        visible: [corporate-account-001, corporate-account-002]
        balance: true
        account_number: true
        routing_number: false

      transactions:
        read: true
        amount_visibility_cap: 50000  # Cap visibility on very large transactions
        description_visibility: true
        lookback_days: 180

      spending:
        max_per_transaction: 10000
        max_daily: 50000
        max_weekly: 100000
        max_monthly: 500000
        merchants:
          allow: []
          block:
            - "cryptocurrency-exchange"
            - "gambling-sites"
        categories:
          allow: []
          block:
            - "entertainment-personal"
            - "bars-restaurants-personal"
        require_itemization: true

      escalation:
        triggers:
          - amount_exceeds: 25000
          - new_merchant: true
          - new_category: false
          - category: ["sensitive-vendor"]
          - daily_spend_exceeds_pct: 80
        channel: webhook
        timeout: "10m"
        default_on_timeout: deny

      schedule:
        active_hours: "06:00-22:00"
        active_days: [monday, tuesday, wednesday, thursday, friday, saturday]
        timezone: "America/New_York"
        blackout_dates:
          - "2024-12-25"  # Christmas
          - "2024-12-31"  # New Year's Eve
          - "2024-01-01"  # New Year's Day
          - "2024-07-04"  # Independence Day
        behavior_outside_schedule: escalate

      audit:
        log_all_queries: true
        log_policy_evaluations: true
        retention: "1y"

global:
  max_total_daily_spend: 1000000
  max_total_weekly_spend: 4000000
  max_total_monthly_spend: 15000000
  max_concurrent_agents: 20
  max_pending_escalations: 50
```

**Webhook Endpoint Example**

When an escalation occurs, Clad sends a POST request to your webhook:

```json
{
  "escalation_id": "esc-00042",
  "agent_id": "autonomous-spender",
  "tool_name": "send_money",
  "decision": "escalate",
  "amount": 35000.00,
  "merchant": "New Equipment Vendor",
  "category": "capital-equipment",
  "trigger": "amount_exceeds",
  "timestamp": "2024-03-31T14:35:00Z",
  "policy": "autonomous-spender",
  "reason": "Amount $35,000.00 exceeds threshold of $25,000.00"
}
```

Your webhook should respond with:

```json
{
  "escalation_id": "esc-00042",
  "decision": "allow",
  "approved_by": "manager@example.com",
  "approval_reason": "Pre-approved vendor, equipment purchase",
  "timestamp": "2024-03-31T15:00:00Z"
}
```

**Integration example (Node.js):**

```javascript
const express = require('express');
const app = express();

app.post('/clad/escalate', express.json(), async (req, res) => {
  const escalation = req.body;

  // Log to approval system
  console.log(`Escalation ${escalation.escalation_id}: ${escalation.agent_id} wants to spend $${escalation.amount}`);

  // Send email/Slack notification to approvers
  await notifyApprovers({
    escalation_id: escalation.escalation_id,
    amount: escalation.amount,
    merchant: escalation.merchant,
    agent_id: escalation.agent_id
  });

  // For now, acknowledge receipt
  res.json({
    escalation_id: escalation.escalation_id,
    status: 'pending_review'
  });
});
```

**To use:**
1. Copy this YAML to `clad.yaml`
2. Update the `webhook_url` to your approval endpoint
3. Customize account IDs, merchants, categories
4. Update blackout dates to match your holidays
5. Run `clad reload`
6. Set up your webhook endpoint to handle approvals

**Claude integration:**
> "I need to purchase $40,000 worth of equipment from a new vendor"
> (Claude asks: "This requires approval. I've escalated it. You can track it with ID: esc-00042")
> "What's the status of my escalation esc-00042?"

---

## Customization Tips

### Adjusting Spending Limits

Based on your organization size:

**Small team ($10K/month budget):**
```yaml
max_per_transaction: 100
max_daily: 500
max_weekly: 2000
max_monthly: 10000
```

**Medium organization ($100K/month):**
```yaml
max_per_transaction: 1000
max_daily: 5000
max_weekly: 20000
max_monthly: 100000
```

**Large organization ($1M/month):**
```yaml
max_per_transaction: 10000
max_daily: 50000
max_weekly: 200000
max_monthly: 1000000
```

### Adding More Agents

Copy an agent block and rename it:

```yaml
agents:
  analyst:
    # ... analyst config
  procurement:
    # ... procurement config
  executive:
    # ... executive config
```

Then configure Claude for each:

```json
{
  "mcpServers": {
    "clad-analyst": {
      "command": "clad",
      "args": ["serve", "--agent", "analyst"]
    },
    "clad-procurement": {
      "command": "clad",
      "args": ["serve", "--agent", "procurement"]
    }
  }
}
```

### Controlling Access to Specific Accounts

Only list accounts the agent should see in the `visible` array:

```yaml
accounts:
  visible: [public-account]    # Only this account is visible
  balance: true
  # private-account is not listed, so the agent cannot see it
```

### Fine-Grained Escalations

Escalate on very specific conditions:

```yaml
escalation:
  triggers:
    - merchant: ["high-risk-vendor"]      # Always escalate this vendor
    - category: ["legal-services"]        # Always escalate legal category
    - amount_exceeds: 5000                # Escalate on large amounts
    - new_merchant: true                  # Escalate on new vendors
    - daily_spend_exceeds_pct: 80         # Escalate near daily limit
```

---

## Next Steps

- **[Policy Reference](/policy-reference)**: Learn about all policy options
- **[Getting Started](/getting-started)**: Set up Clad
- **[Integration Guide](/integration-guides)**: Connect to Claude Desktop
- **[MCP Tools](/mcp-tools)**: See what Claude can do
