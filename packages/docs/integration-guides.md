# Integration Guides

## Claude Desktop Integration

Clad integrates with Claude Desktop through the Model Context Protocol (MCP). This guide walks you through setting up the integration.

### What is MCP?

The Model Context Protocol (MCP) allows Claude to use external tools and services. With Clad's MCP server, Claude gains access to all Clad tools while respecting your financial policies.

### Prerequisites

- Claude Desktop installed
- Clad built from source (`pnpm install && pnpm build`)
- The full path to `node` on your system (run `node -e "process.stdout.write(process.execPath)"`)
- The full path to `packages/cli/dist/index.js` in your Clad clone

### Step 1: Find Your Configuration File

The Claude Desktop configuration file location depends on your operating system.

#### macOS

```bash
~/.config/Claude/claude_desktop_config.json
```

Or using the GUI:
1. Open Claude Desktop
2. Click the "..." menu in the top right
3. Select "Settings" → "Developer"
4. Look for the "Config Location" field

#### Linux

```bash
~/.config/Claude/claude_desktop_config.json
```

Or for Flatpak users:
```bash
~/.var/app/com.anthropic.Claude/config/Claude/claude_desktop_config.json
```

#### Windows

```
%APPDATA%\Claude\claude_desktop_config.json
```

In Command Prompt, this expands to:
```
C:\Users\<YourUsername>\AppData\Roaming\Claude\claude_desktop_config.json
```

### Step 2: Edit the Configuration File

Open the configuration file in your text editor. It should look like this initially:

```json
{
  "mcpServers": {}
}
```

Add the Clad server configuration.

::: warning Always use full absolute paths
Claude Desktop launches MCP servers with a minimal environment that does **not** inherit your shell PATH. Using bare `clad` or `node` will fail with "command not found". You must provide full absolute paths.
:::

**macOS/Linux:**
```json
{
  "mcpServers": {
    "clad": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/clad/packages/cli/dist/index.js", "serve"]
    }
  }
}
```

Find your node path with:
```bash
node -e "process.stdout.write(process.execPath)"
```

**Windows:**
```json
{
  "mcpServers": {
    "clad": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\clad\\packages\\cli\\dist\\index.js", "serve"]
    }
  }
}
```

### Step 3: Restart Claude Desktop

For the configuration changes to take effect, close and reopen Claude Desktop.

After reopening, you should see a "+" indicator next to the input box, showing that MCP servers are available.

### Step 5: Test the Integration

In Claude, try asking a financial question:

> "What accounts do I have access to?"

Claude will use the `clad_get_balances` tool to fetch your accounts, filtered by your policy.

If it works, you'll see:

```
Based on your financial accounts:
- Business Checking: $45,230.50
- Emergency Fund: $150,000.00
```

If you see an error like "Clad is not available," check:

1. Clad is running: `clad status`
2. The config file syntax is correct (use a JSON validator)
3. The clad command path is correct
4. Claude Desktop was restarted after editing the config

### Troubleshooting

#### "Clad is not available" or "MCP does not exist"

**Check 1: Are you using full absolute paths?**

Claude Desktop does not inherit your shell PATH. Using `"command": "clad"` or `"command": "node"` will fail silently.

Fix: use full paths in your config:
```bash
# Find node
node -e "process.stdout.write(process.execPath)"
# => /usr/local/bin/node
```

Your config should look like:
```json
{
  "mcpServers": {
    "clad": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/clad/packages/cli/dist/index.js", "serve"]
    }
  }
}
```

**Check 2: Is the dist directory built?**

```bash
cd /path/to/clad && pnpm build
```

**Check 3: Is the config file JSON valid?**

```bash
python3 -m json.tool ~/.config/Claude/claude_desktop_config.json
```

**Check 4: Did you restart Claude?**

Close Claude completely and reopen it.

#### "Policy validation failed"

Your `clad.yaml` has errors. Validate it:

```bash
clad policy validate clad.yaml
```

Fix any errors reported and restart Clad.

#### "Agent not found in policy"

The agent ID that Claude is using doesn't match your policy. Claude uses the default agent name from your policy. Check your `clad.yaml`:

```bash
clad policy show
```

If you have multiple agents, specify which one Claude should use in the MCP config:

```json
{
  "mcpServers": {
    "clad": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/clad/packages/cli/dist/index.js", "serve", "--agent-id", "my-agent-name"]
    }
  }
}
```

#### "Connection refused on port 3000"

Clad's MCP transport is stdio, not HTTP — there is no port to connect to. If you see this error, your MCP client is misconfigured. Make sure `args` includes `"serve"` (not a port number), and that you're using the stdio transport path in your config.

#### Logs are empty or missing

Check Clad's audit log:

```bash
clad log
```

Filter to recent entries:

```bash
clad log -n 50
```

### Using Clad in Claude

Once integrated, you can ask Claude natural language questions about your finances:

**Check balances:**
> "What's my current checking account balance?"

**Review transactions:**
> "Show me my transactions from March"

**Check spending limits:**
> "How much can I safely spend today?"

**Request a transaction:**
> "Can I send $500 to Acme Corp for office supplies?"

If the transaction requires approval (escalation), Claude will tell you:

> "This transaction requires human approval. Escalation ID: esc-00042. You can approve it with: `clad approve esc-00042`"

### Advanced: Multiple Agents

If you have multiple agents in your policy, configure separate MCP server entries in your Claude config — each pinned to a different agent ID:

```json
{
  "mcpServers": {
    "clad-analyst": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/clad/packages/cli/dist/index.js", "serve", "--agent-id", "analyst-agent"]
    },
    "clad-spender": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/clad/packages/cli/dist/index.js", "serve", "--agent-id", "spender-agent"]
    }
  }
}
```

### Advanced: Webhook Escalations

If your policy uses `escalation.channel: webhook`, escalations are sent to an HTTP endpoint instead of appearing in the CLI.

**Example policy:**
```yaml
agents:
  spender:
    permissions:
      escalation:
        triggers:
          - amount_exceeds: 2000
        channel: webhook
        timeout: "10m"
        default_on_timeout: deny
```

When an escalation occurs, Clad sends a POST request:

```json
{
  "escalation_id": "esc-00042",
  "agent_id": "spender",
  "decision": "escalate",
  "trigger": "amount_exceeds",
  "amount": 2500.00,
  "merchant": "New Vendor",
  "timestamp": "2024-03-31T14:35:00Z"
}
```

Your webhook endpoint should respond with:

```json
{
  "decision": "allow",
  "reason": "Approved by John Doe",
  "approver_id": "john@example.com"
}
```

---

## Programmatic Integration

If you're building a custom application (not Claude Desktop), you can integrate Clad directly:

### Node.js Integration

```bash
npm install @clad/core @clad/mcp-server
```

```typescript
import { CladLayer } from '@clad/core';

const clad = new CladLayer('./clad.yaml');

// Check if an agent can perform an action
const decision = await clad.requestAction({
  agent_id: 'my-agent',
  tool_name: 'send_money',
  amount: 1500.00,
  merchant: 'Acme Corp',
  category: 'office-supplies'
});

if (decision.decision === 'allow') {
  console.log('Transaction approved');
} else if (decision.decision === 'escalate') {
  console.log(`Escalation required: ${decision.escalation_id}`);
} else {
  console.log('Transaction denied');
}
```

### Running the MCP Server

```typescript
import { startMcpServer } from '@clad/mcp-server';

startMcpServer('./clad.yaml', {
  agent_id: 'my-agent',
  port: 3000
});
```

---

## Next Steps

- **[Getting Started](/getting-started)**: Full setup instructions
- **[MCP Tools](/mcp-tools)**: Learn what tools are available
- **[Starter Policies](/starter-policies)**: Copy a ready-to-use policy template
- **[Policy Reference](/policy-reference)**: Understand all policy options
