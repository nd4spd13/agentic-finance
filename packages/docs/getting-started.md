# Getting Started

This guide walks you through setting up Clad and connecting it to an MCP-compatible agent.

## Prerequisites

Before you start, make sure you have:

- **Node.js 22+**: Check with `node --version`
- **pnpm**: Install with `npm install -g pnpm` or check [pnpm.io](https://pnpm.io)
- **An MCP-compatible agent**: e.g. [Claude Desktop](https://claude.ai), or any agent using the [Model Context Protocol](https://modelcontextprotocol.io)

## Installation

Clone the repository, install dependencies, and build:

```bash
git clone https://github.com/yourusername/clad.git
cd clad
pnpm install
pnpm build
```

Add pnpm's global bin directory to your shell PATH (one-time setup):

```bash
pnpm setup
```

Link the `clad` command globally:

```bash
pnpm install-cli
```

Restart your terminal (or run `source ~/.zshrc`), then verify:

```bash
clad --version
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
        visible: [default-account]
        balance: true
        account_number: false
        routing_number: false

      transactions:
        read: true
        description_visibility: true
        lookback_days: 90

      spending:
        max_per_transaction: 10000
        max_daily: 50000
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
        timeout: "5m"
        default_on_timeout: deny

global:
  max_total_daily_spend: 100000
  max_concurrent_agents: 5
```

## Edit Your Policy

### Option A — Visual editor (recommended)

Run the built-in policy editor UI:

```bash
clad ui
```

This starts a local web app at `http://localhost:3456` and opens your browser automatically. It reads your current `clad.yaml`, presents every setting as a form, and writes changes back to disk when you click **Save**. A live YAML preview updates in real-time as you edit.

The editor covers all policy fields:
- **Accounts** — visible account types, balance/routing number visibility
- **Transactions** — read access, lookback window, amount visibility cap
- **Spending** — per-transaction, daily, weekly, and monthly limits; merchant and category allow/block lists
- **Escalation** — trigger conditions, channel (CLI/webhook), timeout, and fallback behavior
- **Schedule** — active hours, active days, timezone, blackout dates
- **Audit** — logging and retention settings
- **Global rules** — org-wide spend caps and agent concurrency limits

Use `--port` to change the default port:

```bash
clad ui --port 8080
```

### Option B — Edit by hand

Open `clad.yaml` directly and customize it for your use case:

**Example: Read-only agent with spending limits**

```yaml
agents:
  analyst-agent:
    description: "Financial analyst - read-only access"
    permissions:
      accounts:
        visible: [checking-01]
        balance: true
        account_number: false
      transactions:
        read: true
        lookback_days: 90
      spending:
        max_per_transaction: 1000
        max_daily: 5000
        require_itemization: false
      escalation:
        triggers:
          - amount_exceeds: 5000
        channel: cli
        timeout: "5m"
        default_on_timeout: deny
```

**Example: Spending agent with merchant restrictions**

```yaml
agents:
  spender-agent:
    description: "Autonomous spender with restrictions"
    permissions:
      accounts:
        visible: [corporate-account]
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
        timeout: "10m"
        default_on_timeout: deny
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
pm2 start clad -- start
pm2 save
pm2 startup
```

## Connect Your MCP Agent

Clad works with any MCP-compatible agent. Below is an example using Claude Desktop — the same JSON structure applies to any MCP client.

### Claude Desktop — macOS/Linux

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

### Claude Desktop — Windows

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

### Multi-agent setup

If your policy defines multiple agents with different permission profiles, pin each MCP server entry to a specific agent using `--agent-id`:

```json
{
  "mcpServers": {
    "clad-financial-advisor": {
      "command": "clad",
      "args": ["serve", "--agent-id", "financial-advisor"]
    },
    "clad-receipt-scanner": {
      "command": "clad",
      "args": ["serve", "--agent-id", "receipt-scanner"]
    }
  }
}
```

You can also set the agent via environment variable if you prefer:

```json
{
  "mcpServers": {
    "clad-financial-advisor": {
      "command": "clad",
      "args": ["serve"],
      "env": {
        "CLAD_AGENT_ID": "financial-advisor"
      }
    }
  }
}
```

The `--agent-id` flag takes precedence over the `CLAD_AGENT_ID` environment variable. If the agent ID isn't found in your policy, Clad will log a warning and deny all requests from that instance.

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

Your MCP agent can now use Clad tools. If using Claude Desktop, try:

> "What's my checking account balance?"

The agent will call the `clad_get_balances` tool, which is checked against your policy before results are returned.

## Common Tasks

### View the Audit Log

```bash
clad log
```

Shows all decisions with timestamps, agents, accounts, and reasons. Filter by agent (`-a`), decision (`-d allow|deny|escalate`), or limit results (`-n 20`):

```bash
clad log -n 20
clad log -a my-agent -d deny
```

### List Configured Agents

```bash
clad policy show
```

### Reload the Policy

Edit `clad.yaml` — the MCP server re-reads the policy on every request, so changes take effect immediately without a restart.

### Review and Action Escalations

List pending escalations:

```bash
clad approvals
```

Approve or deny by ID:

```bash
clad approve <id>
clad deny <id>
```

## Troubleshooting

### "Command not found: clad"

Ensure pnpm's global bin is in your PATH, re-link, then restart your terminal:

```bash
pnpm setup
pnpm install-cli
```

### "MCP Server not responding"

1. Verify the server is running: `clad status`
2. Check that your MCP client config points to the correct command
3. Restart your MCP agent (e.g. Claude Desktop)
4. Check logs: `clad log`

### "Policy validation failed"

Ensure your `clad.yaml` is valid YAML and all required fields are present. Use a YAML validator:

```bash
clad policy validate clad.yaml
```

### Escalations not triggering

Check that:
1. The escalation trigger conditions match your policy (`amount_exceeds`, `new_merchant`, etc.)
2. The escalation channel is set to `cli` or `webhook`
3. The MCP server is running and connected

## Next Steps

- **[Policy Reference](/policy-reference)**: Learn about all available policy options
- **[Starter Policies](/starter-policies)**: Copy ready-to-use policy templates
- **[MCP Tools Reference](/mcp-tools)**: Understand the available MCP tools
- **[Architecture](/architecture)**: Deep dive into how Clad works
