# Getting Started

This guide walks you through setting up Guardian Layer and connecting it to Claude Desktop.

## Prerequisites

Before you start, make sure you have:

- **Node.js 22+**: Check with `node --version`
- **pnpm**: Install with `npm install -g pnpm` or check [pnpm.io](https://pnpm.io)
- **Claude Desktop**: Download from [claude.ai](https://claude.ai)

## Installation

Clone the Guardian Layer repository and install dependencies:

```bash
git clone https://github.com/yourusername/guardian-layer.git
cd guardian-layer
pnpm install
```

Build the project:

```bash
pnpm build
```

## Initialize Guardian Layer

Create a new Guardian Layer instance in your project:

```bash
guardian init
```

This creates a `guardian.yaml` file with a basic policy template. The file will look like this:

```yaml
agents:
  default-agent:
    description: "Default financial agent"
    permissions:
      accounts:
        - id: default-account
          visible: true
          balance: true
          account_number: false
          routing_number: false

      transactions:
        read: true
        amount_visibility_cap: null
        description_visibility: true
        lookback_days: 90

      spending:
        max_per_transaction: 10000
        max_daily: 50000
        max_weekly: null
        max_monthly: null
        merchants:
          allow: []
          block: []
        categories:
          allow: []
          block: []
        require_itemization: false

      escalation:
        triggers:
          - amount_exceeds: 10000
        channel: cli
        timeout: 300
        default_on_timeout: deny

global:
  max_total_daily_spend: 100000
  max_concurrent_agents: 5
```

## Edit Your Policy

Open `guardian.yaml` and customize it for your use case:

**Example: Read-only agent with spending limits**

```yaml
agents:
  analyst-agent:
    description: "Financial analyst - read-only access"
    permissions:
      accounts:
        - id: checking-01
          visible: true
          balance: true
          account_number: false
      transactions:
        read: true
        amount_visibility_cap: null
        lookback_days: 90
      spending:
        max_per_transaction: 1000
        max_daily: 5000
        require_itemization: false
      escalation:
        triggers:
          - amount_exceeds: 5000
        channel: cli
        timeout: 300
```

**Example: Spending agent with merchant restrictions**

```yaml
agents:
  spender-agent:
    description: "Autonomous spender with restrictions"
    permissions:
      accounts:
        - id: corporate-account
          visible: true
          balance: true
      spending:
        max_per_transaction: 500
        max_daily: 2000
        merchants:
          block:
            - high-risk-vendor
            - international-transfer
          allow: []
        categories:
          allow:
            - office-supplies
            - software-licenses
      escalation:
        triggers:
          - amount_exceeds: 1000
          - new_merchant: true
        channel: webhook
        timeout: 600
```

## Start the Server

Start Guardian Layer in the foreground:

```bash
guardian start --foreground
```

You should see output like:

```
Guardian Layer MCP Server
Listening on stdio
Loaded policy from ./guardian.yaml
Ready to accept connections
```

For production, run it as a background service or with a process manager like `pm2`:

```bash
pm2 start guardian -- start
pm2 save
pm2 startup
```

## Configure Claude Desktop

Guardian Layer integrates with Claude Desktop via the Model Context Protocol (MCP).

### macOS/Linux

Edit `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "guardian-layer": {
      "command": "guardian",
      "args": ["serve"]
    }
  }
}
```

### Windows

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "guardian-layer": {
      "command": "guardian",
      "args": ["serve"]
    }
  }
}
```

After editing, restart Claude Desktop for the changes to take effect.

## Verify the Connection

Run the Guardian Layer status command:

```bash
guardian status
```

Expected output:

```
Guardian Layer Status
====================
MCP Server: running
Policy loaded: guardian.yaml
Agents configured: 1
Connected clients: 0
Audit logs: /path/to/guardian.log
```

In Claude Desktop, you can now use Guardian Layer tools in conversations. Start with:

> "What's my checking account balance?"

Claude will use the `guardian_get_balances` tool, which will be checked against your policy before returning results.

## Common Tasks

### View the Audit Log

```bash
guardian audit-log
```

Shows all decisions with timestamps, agents, accounts, and reasons.

### List Configured Agents

```bash
guardian agents list
```

### Reload the Policy

Edit `guardian.yaml` and reload without restarting:

```bash
guardian reload
```

### Escalate a Decision

Manually escalate a pending decision:

```bash
guardian escalate <decision-id>
```

### Check Recent Decisions

```bash
guardian decisions --limit 20
```

## Troubleshooting

### "Command not found: guardian"

Make sure Guardian Layer is installed globally or use the full path to the executable.

```bash
# Install globally
npm install -g @guardian-layer/cli

# Or use via pnpm
pnpm exec guardian status
```

### "MCP Server not responding"

1. Verify the server is running: `guardian status`
2. Check that `claude_desktop_config.json` points to the correct command
3. Restart Claude Desktop
4. Check logs: `guardian logs`

### "Policy validation failed"

Ensure your `guardian.yaml` is valid YAML and all required fields are present. Use a YAML validator:

```bash
guardian validate guardian.yaml
```

### Escalations not triggering

Check that:
1. The escalation trigger conditions match your policy (`amount_exceeds`, `new_merchant`, etc.)
2. The escalation channel is set to `cli` or `webhook`
3. The MCP server is running and connected

## Next Steps

- **[Policy Reference](/policy-reference)**: Learn about all available policy options
- **[Starter Policies](/starter-policies)**: Copy ready-to-use policy templates
- **[MCP Tools Reference](/mcp-tools)**: Understand what Claude can do with Guardian Layer
- **[Architecture](/architecture)**: Deep dive into how Guardian Layer works
