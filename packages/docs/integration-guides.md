# Integration Guides

## Claude Desktop Integration

Clad integrates with Claude Desktop through the Model Context Protocol (MCP). This guide walks you through setting up the integration.

### What is MCP?

The Model Context Protocol (MCP) allows Claude to use external tools and services. With Clad's MCP server, Claude gains access to all Clad tools while respecting your financial policies.

### Prerequisites

- Claude Desktop installed
- Clad installed and configured with a `clad.yaml` policy
- The `clad` CLI command available in your PATH (or you know its full path)

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

Add the Clad server configuration:

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

If `clad` is not in your PATH, provide the full path:

```json
{
  "mcpServers": {
    "clad": {
      "command": "/usr/local/bin/clad",
      "args": ["serve"]
    }
  }
}
```

On Windows:
```json
{
  "mcpServers": {
    "clad": {
      "command": "C:\\Users\\YourUsername\\AppData\\Local\\clad\\bin\\clad.exe",
      "args": ["serve"]
    }
  }
}
```

### Step 3: Verify the Clad Server is Running

Before starting Claude, make sure Clad is running:

```bash
clad status
```

Expected output:

```
Clad Status
====================
MCP Server: running
Policy loaded: clad.yaml
Agents configured: 3
Connected clients: 0
Audit logs: /path/to/audit.log
```

If the server is not running, start it:

```bash
# In one terminal, start Clad
clad start --foreground
```

Keep this terminal open while using Claude.

Alternatively, run it as a background service:

```bash
clad start
```

### Step 4: Restart Claude Desktop

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

#### "Clad is not available"

**Check 1: Is Clad running?**
```bash
clad status
```

If not running, start it:
```bash
clad start
```

**Check 2: Is the config file correct?**

Validate the JSON:
```bash
python3 -m json.tool ~/.config/Claude/claude_desktop_config.json
```

**Check 3: Is the clad command in PATH?**

```bash
which clad
```

If not found, use the full path in the config file.

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
clad agents list
```

If you have multiple agents, specify which one Claude should use in the MCP config:

```json
{
  "mcpServers": {
    "clad": {
      "command": "clad",
      "args": ["serve", "--agent", "my-agent-name"]
    }
  }
}
```

#### "Connection refused on port 3000"

Clad is running but not accessible. Make sure it's running on stdio (not HTTP):

```bash
clad start --foreground
```

The `--foreground` flag starts Clad on stdio, which MCP uses.

#### Logs are empty or missing

Check Clad's log output:

```bash
clad logs
```

For live logs while Clad is running:

```bash
clad logs --follow
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

> "This transaction requires human approval. Escalation ID: esc-00042. You can approve it with: `clad escalate esc-00042 --approve`"

### Advanced: Multiple Agents

If you have multiple agents in your policy, you can run separate Clad instances for each:

**Terminal 1 (Analyst agent):**
```bash
clad start --agent analyst-agent --port 3001
```

**Terminal 2 (Spender agent):**
```bash
clad start --agent spender-agent --port 3002
```

**Claude config:**
```json
{
  "mcpServers": {
    "clad-analyst": {
      "command": "clad",
      "args": ["serve", "--agent", "analyst-agent"]
    },
    "clad-spender": {
      "command": "clad",
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
