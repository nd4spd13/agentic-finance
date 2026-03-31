# Integration Guides

## Claude Desktop Integration

Guardian Layer integrates with Claude Desktop through the Model Context Protocol (MCP). This guide walks you through setting up the integration.

### What is MCP?

The Model Context Protocol (MCP) allows Claude to use external tools and services. With Guardian Layer's MCP server, Claude gains access to all Guardian Layer tools while respecting your financial policies.

### Prerequisites

- Claude Desktop installed
- Guardian Layer installed and configured with a `guardian.yaml` policy
- The `guardian` CLI command available in your PATH (or you know its full path)

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

Add the Guardian Layer server configuration:

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

If `guardian` is not in your PATH, provide the full path:

```json
{
  "mcpServers": {
    "guardian-layer": {
      "command": "/usr/local/bin/guardian",
      "args": ["serve"]
    }
  }
}
```

On Windows:
```json
{
  "mcpServers": {
    "guardian-layer": {
      "command": "C:\\Users\\YourUsername\\AppData\\Local\\guardian\\bin\\guardian.exe",
      "args": ["serve"]
    }
  }
}
```

### Step 3: Verify the Guardian Server is Running

Before starting Claude, make sure Guardian Layer is running:

```bash
guardian status
```

Expected output:

```
Guardian Layer Status
====================
MCP Server: running
Policy loaded: guardian.yaml
Agents configured: 3
Connected clients: 0
Audit logs: /path/to/audit.log
```

If the server is not running, start it:

```bash
# In one terminal, start Guardian Layer
guardian start --foreground
```

Keep this terminal open while using Claude.

Alternatively, run it as a background service:

```bash
guardian start
```

### Step 4: Restart Claude Desktop

For the configuration changes to take effect, close and reopen Claude Desktop.

After reopening, you should see a "+" indicator next to the input box, showing that MCP servers are available.

### Step 5: Test the Integration

In Claude, try asking a financial question:

> "What accounts do I have access to?"

Claude will use the `guardian_get_balances` tool to fetch your accounts, filtered by your policy.

If it works, you'll see:

```
Based on your financial accounts:
- Business Checking: $45,230.50
- Emergency Fund: $150,000.00
```

If you see an error like "Guardian Layer is not available," check:

1. Guardian Layer is running: `guardian status`
2. The config file syntax is correct (use a JSON validator)
3. The guardian command path is correct
4. Claude Desktop was restarted after editing the config

### Troubleshooting

#### "Guardian Layer is not available"

**Check 1: Is Guardian running?**
```bash
guardian status
```

If not running, start it:
```bash
guardian start
```

**Check 2: Is the config file correct?**

Validate the JSON:
```bash
python3 -m json.tool ~/.config/Claude/claude_desktop_config.json
```

**Check 3: Is the guardian command in PATH?**

```bash
which guardian
```

If not found, use the full path in the config file.

**Check 4: Did you restart Claude?**

Close Claude completely and reopen it.

#### "Policy validation failed"

Your `guardian.yaml` has errors. Validate it:

```bash
guardian validate guardian.yaml
```

Fix any errors reported and restart Guardian.

#### "Agent not found in policy"

The agent ID that Claude is using doesn't match your policy. Claude uses the default agent name from your policy. Check your `guardian.yaml`:

```bash
guardian agents list
```

If you have multiple agents, specify which one Claude should use in the MCP config:

```json
{
  "mcpServers": {
    "guardian-layer": {
      "command": "guardian",
      "args": ["serve", "--agent", "my-agent-name"]
    }
  }
}
```

#### "Connection refused on port 3000"

Guardian is running but not accessible. Make sure it's running on stdio (not HTTP):

```bash
guardian start --foreground
```

The `--foreground` flag starts Guardian on stdio, which MCP uses.

#### Logs are empty or missing

Check Guardian's log output:

```bash
guardian logs
```

For live logs while Guardian is running:

```bash
guardian logs --follow
```

### Using Guardian Layer in Claude

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

> "This transaction requires human approval. Escalation ID: esc-00042. You can approve it with: `guardian escalate esc-00042 --approve`"

### Advanced: Multiple Agents

If you have multiple agents in your policy, you can run separate Guardian Layer instances for each:

**Terminal 1 (Analyst agent):**
```bash
guardian start --agent analyst-agent --port 3001
```

**Terminal 2 (Spender agent):**
```bash
guardian start --agent spender-agent --port 3002
```

**Claude config:**
```json
{
  "mcpServers": {
    "guardian-analyst": {
      "command": "guardian",
      "args": ["serve", "--agent", "analyst-agent"]
    },
    "guardian-spender": {
      "command": "guardian",
      "args": ["serve", "--agent", "spender-agent"]
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
        channel: webhook
        webhook_url: "https://internal.example.com/guardian/escalate"
        timeout: 600
```

When an escalation occurs, Guardian sends a POST request:

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

If you're building a custom application (not Claude Desktop), you can integrate Guardian Layer directly:

### Node.js Integration

```bash
npm install @guardian-layer/core @guardian-layer/mcp-server
```

```typescript
import { GuardianLayer } from '@guardian-layer/core';

const guardian = new GuardianLayer('./guardian.yaml');

// Check if an agent can perform an action
const decision = await guardian.requestAction({
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
import { startMcpServer } from '@guardian-layer/mcp-server';

startMcpServer('./guardian.yaml', {
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
