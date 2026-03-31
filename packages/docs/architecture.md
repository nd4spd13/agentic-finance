# Architecture

This document describes the design, components, and security model of Guardian Layer.

## System Overview

Guardian Layer sits between AI agents and financial data providers, enforcing policies at the MCP layer.

```
┌─────────────────┐
│  Claude Desktop │
│    (or other    │
│   MCP client)   │
└────────┬────────┘
         │ MCP Protocol
         │
┌────────▼──────────────────────────────────────┐
│         Guardian Layer MCP Server             │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │   Policy Evaluator                       │ │
│ │  - Parse & validate policies             │ │
│ │  - Evaluate agent permissions            │ │
│ │  - Check spending constraints            │ │
│ │  - Execute escalation triggers           │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │   Audit Logger                           │ │
│ │  - Record every decision                 │ │
│ │  - Chain hash entries for integrity      │ │
│ │  - Filter by agent permissions           │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │   Approval Queue                         │ │
│ │  - Store pending escalations             │ │
│ │  - Track approval status                 │ │
│ │  - Send to webhook or CLI                │ │
│ └──────────────────────────────────────────┘ │
└────────┬──────────────────────────────────────┘
         │
         │ Structured API calls
         │
┌────────▼──────────────────────────────────────┐
│      Data Provider Interface                 │
│  (Plaid, custom bank integration, etc.)      │
└──────────────────────────────────────────────┘
```

## Data Flow

Here's what happens when Claude makes a financial request:

1. **Agent Request**
   - Claude (via MCP) calls `guardian_request_action` with amount, merchant, category
   - Includes agent ID and account ID

2. **Policy Lookup**
   - Policy Evaluator loads `guardian.yaml`
   - Finds the agent's policy definition
   - Verifies agent exists (deny if not found)

3. **Permission Checks** (in order)
   - Schedule check: Is it within active_hours/active_days?
   - Account access: Can agent access this account?
   - Spending limits: Per-transaction, daily, weekly, monthly?
   - Merchant control: Is merchant whitelisted/blacklisted?
   - Category control: Is category whitelisted/blacklisted?
   - Global limits: Does org-wide spending allow this?

4. **Decision**
   - If all checks pass: `decision: allow`
   - If any check fails: `decision: deny`
   - If escalation trigger matches: `decision: escalate`

5. **Audit Log**
   - Record the decision (timestamp, agent, amount, merchant, reason)
   - Calculate chain hash: `hash(entry + previous_hash)`
   - Store in audit log

6. **Escalation (if needed)**
   - Add to approval queue
   - Send to webhook OR store for CLI retrieval
   - Wait for human decision or timeout

7. **Response**
   - Return decision to Claude
   - Include escalation ID if escalated
   - Include reason for deny/escalate

## Components

### Core Components

**Policy Engine** (`@guardian-layer/core`)
- YAML parser and validator
- Policy structure definition (TypeScript interfaces)
- Decision evaluation logic
- Spending constraint calculation

**MCP Server** (`@guardian-layer/mcp-server`)
- Implements the 5 MCP tools
- Routes requests to policy engine
- Handles authentication (agent ID verification)
- Formats responses for MCP clients

**Audit Logger** (`@guardian-layer/core`)
- Append-only audit log
- Chain hashing for tamper-evidence
- Filtering by agent and permission level
- Serialization to file or database

**Approval Queue** (`@guardian-layer/core`)
- In-memory or persistent storage of escalations
- Webhook dispatch to external systems
- CLI integration for manual approvals
- Timeout handling and default decision logic

### CLI (`@guardian-layer/cli`)

Command-line interface for:
- `guardian init` - Create default policy
- `guardian serve` - Start MCP server
- `guardian status` - Check server status
- `guardian reload` - Reload policy from disk
- `guardian escalate` - Approve/deny escalations
- `guardian audit-log` - View decision history
- `guardian validate` - Validate policy syntax

## Security Model

### Default-Deny Principle

Guardian Layer uses a default-deny security model:

1. **Agents are not mentioned in policy** → Denied
2. **Accounts not in agent's list** → Denied
3. **Permissions not explicitly granted** → Denied
4. **Request outside schedule** → Denied by default

This means policies must explicitly whitelist what agents can do, rather than blacklisting what they cannot.

### Constraint Sources

Guardian Layer aligns with established financial permission frameworks:

**AP2 (Agentic Permissions Protocol v2)**
- Spending limit hierarchy: per-transaction, daily, weekly, monthly
- Merchant and category controls
- Account visibility and field visibility

**Nekuda (Temporal Execution Framework)**
- Active hours enforcement
- Active days (weekday/weekend)
- Timezone support
- Blackout dates
- Behavior outside schedule

**Novel (Escalation Framework)**
- Escalation triggers (amount, new merchant, category, percentages)
- Multiple escalation channels (CLI, webhook)
- Timeout and default decision logic
- Approval tracking

### Tamper-Evidence via Chain Hashing

Every audit log entry includes:
- Entry hash: `SHA-256(entry_data)`
- Previous hash: The hash of the previous entry
- Chain verification: New entries can only be added, not modified

```
Entry 1: hash=abc, prev=null
Entry 2: hash=def, prev=abc
Entry 3: hash=ghi, prev=def
```

If someone modifies Entry 2:
- Its hash would change (e.g., to `xyz`)
- Entry 3 would no longer link to it (prev=def, but Entry 2's hash is now xyz)
- Tampering is immediately detectable

### Policy Integrity

Policies are treated as trusted source code:
- Version controlled (git)
- Subject to code review (like pull requests)
- Immutable once loaded (reloading requires restart)
- Auditable changes (git history shows who changed what and when)

### Agent Identity

Agents are identified by:
- `agent_id` in request (provided by MCP client)
- Verified against policy configuration
- No cryptographic proof in basic mode (assumes trusted MCP client)
- Optional: Agent authentication keys in production

## Spending Constraint Evaluation

When evaluating spending, Guardian Layer checks constraints in this order:

```
1. Agent exists in policy?
   NO  → DENY
   YES → continue

2. Account visible to agent?
   NO  → DENY
   YES → continue

3. Within schedule (active_hours, active_days)?
   NO  → Apply behavior_outside_schedule (deny/escalate/allow)
   YES → continue

4. Within per-transaction limit?
   NO  → DENY or ESCALATE
   YES → continue

5. Within daily limit?
   NO  → DENY or ESCALATE
   YES → continue

6. Within weekly limit?
   NO  → DENY or ESCALATE
   YES → continue

7. Within monthly limit?
   NO  → DENY or ESCALATE
   YES → continue

8. Within global org limit?
   NO  → DENY or ESCALATE
   YES → continue

9. Merchant in whitelist (if whitelist exists)?
   NO  → DENY
   YES → continue

10. Merchant in blacklist?
    YES → DENY
    NO  → continue

11. Category in whitelist (if whitelist exists)?
    NO  → DENY
    YES → continue

12. Category in blacklist?
    YES → DENY
    NO  → continue

13. Any escalation triggers matched?
    YES → ESCALATE
    NO  → ALLOW
```

## Escalation Workflow

### CLI-Based Escalation

```
1. Agent makes request
2. Guardian evaluates, triggers escalation
3. Escalation stored in approval queue
4. User sees in CLI: guardian escalate --list
5. User reviews: guardian escalate <id> --show
6. User decides: guardian escalate <id> --approve
7. Guardian records decision in audit log
```

### Webhook-Based Escalation

```
1. Agent makes request
2. Guardian evaluates, triggers escalation
3. Guardian POSTs to webhook URL with escalation details
4. Webhook integration (e.g., email approval) handles it
5. External system POSTs back to Guardian with decision
6. Guardian records decision in audit log
7. Future requests are resolved (allowed or denied)
```

## Performance Considerations

**Policy Loading**
- Policy file loaded and parsed at startup
- Cached in memory
- `guardian reload` re-parses and updates
- No persistent database required (audit logs stored separately)

**Decision Latency**
- Policy evaluation: ~1-5ms (memory lookup + constraint checking)
- Audit logging: ~1-10ms (write to disk or database)
- Total per request: ~10-20ms typical

**Audit Log Storage**
- Default: append-only file (guardian.log)
- Optional: database backend (PostgreSQL, etc.)
- Chain hashing adds negligible overhead (~0.1ms per entry)

**Escalation Storage**
- In-memory queue by default
- Optional: persistent backend
- Webhook dispatch: asynchronous, non-blocking

## Extensibility

### Custom Data Providers

Guardian Layer provides a data provider interface:

```typescript
interface DataProvider {
  getBalances(account_ids: string[]): Promise<Balance[]>;
  getTransactions(account_id: string, params: QueryParams): Promise<Transaction[]>;
  // Add more methods as needed
}
```

Implementations:
- Plaid integration (production)
- Test mock provider (development)
- Custom bank API integration

### Custom Escalation Handlers

Extensible escalation system:

```typescript
interface EscalationHandler {
  handle(escalation: Escalation): Promise<Decision>;
  supports(channel: string): boolean;
}
```

Implementations:
- CLI handler
- Webhook handler
- Slack handler (custom)
- Email handler (custom)

### Policy Hooks

Optional hooks for custom logic:

```typescript
interface PolicyHook {
  onPolicyLoad(policy: GuardianPolicy): void;
  beforeEvaluate(request: Request): void;
  afterEvaluate(request: Request, decision: Decision): void;
  onAuditLog(entry: AuditEntry): void;
}
```

## Deployment

### Single-Agent Deployment

For a single agent (most common):

```bash
guardian start --foreground
# Claude Desktop connects via MCP
```

### Multi-Agent Deployment

For multiple agents with separate policies:

```bash
# Terminal 1
guardian start --agent analyst --port 3001 --foreground

# Terminal 2
guardian start --agent spender --port 3002 --foreground

# Claude config
{
  "mcpServers": {
    "guardian-analyst": { "command": "guardian", "args": ["serve", "--agent", "analyst"] },
    "guardian-spender": { "command": "guardian", "args": ["serve", "--agent", "spender"] }
  }
}
```

### Production Deployment

For production:
- Run Guardian as systemd service or with process manager (pm2, supervisor)
- Store audit logs in persistent database (PostgreSQL)
- Use webhook escalations for approval routing
- Monitor logs and audit trail
- Regular policy reviews and audits

## Audit and Compliance

**What's Recorded:**
- Every policy evaluation (agent, decision, amount, merchant, category)
- Every escalation (trigger, agent, timeout status)
- Every approval (approver, reason, timestamp)
- Policy changes (when loaded, hash of policy)

**Retention:**
- Audit logs kept permanently (append-only, immutable)
- Escalations kept until resolved
- Decisions chain-hashed for integrity verification

**Access Control:**
- Agents can view their own audit log entries (if permitted)
- Privileged agents can view all entries (if permitted)
- Webhook logs available via API

**Compliance:**
- Supports SOX, PCI-DSS, and similar audit requirements
- Immutable audit trail prevents after-the-fact modification
- Chain hashing enables detection of tampering
- Full transaction context recorded

## Next Steps

- **[Getting Started](/getting-started)**: Set up Guardian Layer
- **[Policy Reference](/policy-reference)**: Learn all policy options
- **[MCP Tools](/mcp-tools)**: See available tools
- **[Integration Guide](/integration-guides)**: Connect to Claude
