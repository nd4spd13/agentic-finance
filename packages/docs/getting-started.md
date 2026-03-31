# Getting Started

This guide walks you through setting up Clad and connecting it to Claude Desktop.

## Prerequisites

Before you start, make sure you have:

- **Node.js 22+**: Check with `node --version`
- **pnpm**: Install with `npm install -g pnpm` or check [pnpm.io](https://pnpm.io)
- **Claude Desktop**: Download from [claude.ai](https://claude.ai)

## Installation

Clone the Clad repository and install dependencies:

```bash
git clone https://github.com/yourusername/clad.git
cd clad
pnpm install
```

Build the project:

```bash
pnpm build
```

## Initialize Clad

Create a new Clad instance in your project:

```bash
clad init
```

This creates a `clad.yaml` file with a basic policy template. The file will look like this:

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

Open `clad.yaml` and customize it for your use case:

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

Start Clad in the foreground:

```bash
clad start --foreground
```

You should see output like:

```
Clad MCP Server
Listening on stdio
Loaded policy from ./clad.yaml
Ready to accept connections
```

For production, run it as a background service or with a process manager like `pm2`:

```bash
pm2 start guardian -- start
pm2 save
pm2 startup
```

## Configure Claude Desktop

Clad integrates with Claude Desktop via the Model Context Protocol (MCP).

### macOS/Linux

Edit `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clad": {
      "command": "clad",
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
    "clad": {
      "command": "clad",
      "args": ["serve"]
    }
  }
}
```

After editing, restart Claude Desktop for the changes to take effect.

## Verify the Connection

Run the Clad status command:

```bash
clad status
```

Expected output:

```
Clad Status
====================
MCP Server: running
Policy loaded: clad.yaml
Agents configured: 1
Connected clients: 0
Audit logs: /path/to/clad.log
```

In Claude Desktop, you can now use Clad tools in conversations. Start with:

> "What's my checking account balance?"

Claude will use the `clad_get_balances` tool, which will be checked against your policy before returning results.

## Common Tasks

### View the Audit Log

```bash
clad audit-log
```

Shows all decisions with timestamps, agents, accounts, and reasons.

### List Configured Agents

```bash
clad agents list
```

### Reload the Policy

Edit `clad.yaml` and reload without restarting:

```bash
clad reload
```

### Escalate a Decision

Manually escalate a pending decision:

```bash
clad escalate <decision-id>
```

### Check Recent Decisions

```bash
clad decisions --limit 20
```

## Troubleshooting

### "Command not found: guardian"

Make sure Clad is installed globally or use the full path to the executable.

```bash
# Install globally
npm install -g @clad/cli

# Or use via pnpm
pnpm exec clad status
```

### "MCP Server not responding"

1. Verify the server is running: `clad status`
2. Check that `claude_desktop_config.json` points to the correct command
3. Restart Claude Desktop
4. Check logs: `clad logs`

### "Policy validation failed"

Ensure your `clad.yaml` is valid YAML and all required fields are present. Use a YAML validator:

```bash
clad validate clad.yaml
```

### Escalations not triggering

Check that:
1. The escalation trigger conditions match your policy (`amount_exceeds`, `new_merchant`, etc.)
2. The escalation channel is set to `cli` or `webhook`
3. The MCP server is running and connected

## Next Steps

- **[Policy Reference](/policy-reference)**: Learn about all available policy options
- **[Starter Policies](/starter-policies)**: Copy ready-to-use policy templates
- **[MCP Tools Reference](/mcp-tools)**: Understand what Claude can do with Clad
- **[Architecture](/architecture)**: Deep dive into how Clad works
