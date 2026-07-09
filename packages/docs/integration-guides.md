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

## Connecting a bank via Plaid (sandbox)

Clad ships a [Plaid](https://plaid.com/) adapter (`@clad/plaid-adapter`) that implements the same `FinancialDataProvider` interface as the built-in dummy data provider. Today it is wired up and tested against **Plaid's Sandbox environment only** — production Plaid access is gated behind a compliance review (tracked as CRS-43) and is not yet available.

### Required environment variables

Plaid credentials are read from the environment only — they are **never** written to `~/.clad/config.json` or any other file on disk.

```bash
# .env (or export these in your shell before running `clad connect` / `clad serve`)
PLAID_CLIENT_ID=your-sandbox-client-id
PLAID_SECRET=your-sandbox-secret
PLAID_ENV=sandbox

# Encrypts the Plaid access token store at rest. Pick a strong passphrase and
# keep it out of version control. If unset, `clad connect` will prompt for it
# interactively (input is not echoed to the terminal).
CLAD_TOKEN_PASSPHRASE=a-long-random-passphrase
```

Get sandbox credentials from the [Plaid Dashboard](https://dashboard.plaid.com/) (a free Plaid account is sufficient — sandbox does not touch real bank data).

### `clad connect` walkthrough

`clad connect` drives Plaid Link and stores the resulting access token, encrypted, via `SqliteTokenStore`. It never prints or logs the token itself.

**Interactive browser flow** (mirrors what an end user would see in production):

```bash
export PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox
clad connect
```

This opens your system browser to a locally-hosted page that embeds Plaid Link. Pick a sandbox institution (e.g. "First Platypus Bank") and use Plaid's [sandbox test credentials](https://plaid.com/docs/sandbox/test-credentials/) (`user_good` / `pass_good`) to complete the flow. On success, Clad exchanges the `public_token` for an `access_token` server-side and stores it — the callback server binds to `127.0.0.1` only and is gated behind a single-use random path segment.

**Non-interactive sandbox flow** (useful for scripts, CI smoke tests, or this repo's manual test procedures) — mints and exchanges a sandbox `public_token` with no browser involved:

```bash
export PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox
clad connect --sandbox-auto
```

`--sandbox-auto` refuses to run unless `PLAID_ENV=sandbox`, so it can never accidentally touch a real account.

Both flows print the linked institution name and (for the browser flow) masked account details — never the access token:

```
✓ Connected: First Platypus Bank
  Item: item-abc123...
  Linked accounts:
    - Plaid Checking (checking) ••••0000
```

Add `--use` to also flip your local config's `provider` field to `'plaid'` in the same step:

```bash
clad connect --sandbox-auto --use
```

### The passphrase model

Access tokens are encrypted at rest with **AES-256-GCM**, under a key derived from `CLAD_TOKEN_PASSPHRASE` via **scrypt** (a memory-hard KDF, resistant to brute-force/GPU attacks). The database file (`plaid.sqlite`, or the path set by `plaid_db` in `config.json`) only ever contains ciphertext, an IV, and a GCM auth tag — reopening the store with the wrong passphrase fails a key-check and raises `TokenStoreKeyError`, whose message carries no secret material.

Today the passphrase is supplied via `CLAD_TOKEN_PASSPHRASE` (or an interactive prompt). **OS-keychain integration (macOS Keychain, Windows Credential Manager, etc.) is deferred** — tracked as future work — so for now you are responsible for keeping the passphrase itself somewhere safe (a password manager, a secrets manager, etc.). Losing it means losing access to any stored Plaid items; you would need to `clad connect` again.

### Switching the provider to Plaid

Clad's `~/.clad/config.json` has a `provider` field (`'dummy'` by default, or `'plaid'`). There are three ways to set it:

1. **`clad connect --use`** — sets `provider: 'plaid'` in `config.json` after a successful connection.
2. **Edit `config.json` directly** — set `"provider": "plaid"`.
3. **`CLAD_PROVIDER` environment variable** — when set, it overrides whatever is in `config.json` for that process.

`clad serve` reads `config.json` and forwards `provider` to the MCP server subprocess as `CLAD_PROVIDER`; if you invoke `packages/mcp-server/dist/server.js` directly (bypassing the CLI), it reads `CLAD_PROVIDER` from its own environment with no config file involved — so at that layer, the environment variable is authoritative.

When `CLAD_PROVIDER=plaid`, the server also requires `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, and `CLAD_TOKEN_PASSPHRASE` in its environment, and fails fast at startup naming any that are missing. The token store / cache database path comes from `CLAD_PLAID_DB` (forwarded from `plaid_db` in `config.json` by `clad serve`), defaulting to `~/.clad/plaid.sqlite`. A wrong passphrase also fails fast at startup (`TokenStoreKeyError`) rather than serving with an unreadable token store.

### Stale-data semantics

Plaid calls can fail transiently (network issues, Plaid outages, rate limits). `PlaidAdapter` degrades gracefully instead of hard-failing every request:

- If a Plaid API call fails but a **cached** copy of the requested data exists (from a previous successful sync), the adapter serves the cache with `stale: true` set on each returned `Account` / `Balance` / `Transaction`. Callers (including MCP tool responses) can surface this to the agent or user.
- If a Plaid API call fails and **no cache exists yet** (e.g. the very first call after connecting, before anything has synced), the adapter throws `ProviderUnavailableError` — there is nothing sensible to serve.
- Re-authentication failures (Plaid's `ITEM_LOGIN_REQUIRED`) always throw `ProviderAuthError` immediately rather than degrading, since serving stale data would hide the fact that the user needs to reconnect the item.

### What never leaves your device

- **Access tokens are encrypted at rest** (AES-256-GCM, scrypt-derived key) and are never written to disk in plaintext, logged, or printed by any Clad command.
- **MCP clients never see tokens.** Agents talking to Clad over MCP only ever receive `Account` / `Balance` / `Transaction` / `RecurringCharge` data — the token store is not reachable from the MCP tool surface.
- **All data is local.** The only outbound network calls Clad makes are to Plaid's API (to sync accounts/transactions/recurring charges); everything else — the policy engine, audit log, approval queue, and token store — lives on your machine.
- Any error message that could embed request/response data (which, for Plaid/axios errors, can include secrets) is passed through `redactSecrets` before it is thrown, logged, or displayed.

---

## Connecting a bank via SimpleFIN

Clad also ships a [SimpleFIN](https://www.simplefin.org/) Bridge adapter (`@clad/simplefin-adapter`) that implements the same `FinancialDataProvider` interface the Plaid adapter above does — the same `Account`/`Balance`/`Transaction` shapes, the same MCP tools, the same policy/audit path. It's a second on-ramp to the same data, not a second product; pick whichever suits how you want to connect a bank.

### What SimpleFIN Bridge is, and why it's here alongside Plaid

[SimpleFIN Bridge](https://www.simplefin.org/) is a small, user-funded account-aggregation service. **You subscribe directly to SimpleFIN — $1.50/month or $15/year — not to Clad.** You link your banks on the Bridge's own site, generate a one-time **setup token**, and paste that token into Clad. From then on, data flows **directly between your device and the Bridge**; Clad-the-company is never in the path.

That's the entire reason this adapter exists, and it follows directly from two of Clad's [binding roadmap principles](/roadmap#binding-principles):

- **P1 — Clad servers are never a party to financial data.** No proxying of balances or transactions through Clad-operated infrastructure, ever.
- **P2 — Secrets never ship in binaries.** No company-owned aggregator credentials are baked into any Clad client. Plaid requires *you* to hold a developer account and API keys; a SimpleFIN setup token is minted for you, by SimpleFIN, the moment you subscribe — Clad never needs (or gets) a company-wide key to use it.

Practically, this makes SimpleFIN the **low-friction path**: no developer account, no sandbox/production compliance review, no API keys to provision. You pay a few dollars a month, paste a token, and you're connected. Plaid remains the better fit for broader institution coverage and a richer product surface (e.g. recurring-charge detection, which SimpleFIN's protocol has no analog for); SimpleFIN is for anyone who'd rather not have a developer relationship with a data aggregator at all. (Precedent: this is the same aggregator [Actual Budget](https://actualbudget.org/) uses, for the same reason.)

### Setup walkthrough

1. **Subscribe and link your banks** at [`bridge.simplefin.org/simplefin/create`](https://bridge.simplefin.org/simplefin/create) ($1.50/mo or $15/yr), then link the institutions you want Clad to see.
2. **Generate a setup token** on that same page once your banks are linked.
3. **Paste it into Clad:**

   ```bash
   clad connect --provider simplefin
   ```

   This prompts for a token-store passphrase (encrypts the credential at rest — the identical mechanism described in "The passphrase model" above), then for the setup token itself. Paste it and press enter — setup tokens are one-time-use, so there's nothing sensitive about it being visible as you paste it:

   ```
   clad connect: SimpleFIN Bridge
     1. Generate a setup token:
          https://bridge.simplefin.org/simplefin/create
        (a free demo token is available at https://beta-bridge.simplefin.org/info/developers)
     2. Paste the setup token below. It is one-time use — pasting it here
        consumes it, so this prompt does not need to hide your input.

   SimpleFIN setup token: <paste here>

   ✓ Connected: SimpleFIN Bridge
     Item: simplefin-8f2c1e40-...
     Institution(s): Chase
     Linked accounts:
       - Checking ••••3f21
       - Savings ••••90ab
   ```

4. **Switch the provider to SimpleFIN**, the same three ways described for Plaid above:
   - `clad connect --provider simplefin --use`
   - edit `config.json` and set `"provider": "simplefin"`
   - set the `CLAD_PROVIDER=simplefin` environment variable (overrides `config.json` for that process)

### Trying it out with the demo Bridge (no subscription required)

SimpleFIN publishes a public **demo Bridge** with synthetic accounts, useful for kicking the tires before paying for a real subscription:

```bash
clad connect --provider simplefin
# at the token prompt, paste a fresh demo token from:
#   https://beta-bridge.simplefin.org/info/developers
```

That page mints a new, one-time demo setup token on every load ("refresh this page to generate another one") — always grab a fresh one. A token copied from a screenshot, an old browser tab, or these docs has almost certainly already been claimed by someone else. The demo Bridge shares a small daily request quota across everyone using it, so avoid reconnecting or force-refreshing repeatedly.

### Rate-limit expectations

The SimpleFIN protocol allows roughly **24 `/accounts` requests per day** per connection, and the upstream account data itself typically only refreshes **about once a day** regardless of how often it's requested. Two consequences follow:

- **Clad enforces a minimum 6-hour refresh interval per connection by default.** Every read — a balance check, a transaction list, an MCP tool call — is served from Clad's local cache; a live request to the Bridge only goes out when that connection hasn't been refreshed in the last 6 hours. This isn't a workaround for a limitation; it's the correct behavior, since the underlying data hasn't changed more often than that anyway.
- **Polling more often buys nothing.** Restarting `clad serve`, calling `clad_get_balances` in a tight loop, or scripting a faster poll will not surface newer data any sooner — it only spends down the shared daily quota, risking the Bridge disabling the access token for abuse. If you need a refresh on a specific day (e.g. right after a large purchase), one normal request is enough to trigger it once the interval has elapsed; there's no "hold refresh" equivalent that helps here.

If a connection's access URL is ever rejected (HTTP 403 — revoked or compromised), Clad surfaces a clear prompt to re-link with a fresh setup token; a lapsed SimpleFIN subscription (HTTP 402) surfaces as an explicit "renew your subscription" message rather than a generic failure.

### Security note: the access URL is a credential

Claiming a setup token returns an **access URL** with embedded HTTP basic-auth credentials (`https://user:pass@bridge-host/...`). This access URL *is* the credential — equivalent in sensitivity to a Plaid access token — and Clad treats it accordingly:

- **Encrypted at rest**, via the identical mechanism used for Plaid tokens: AES-256-GCM under a scrypt-derived key from `CLAD_TOKEN_PASSPHRASE` (see "The passphrase model" above — same `SqliteTokenStore`, same guarantees).
- **Never displayed.** `clad connect`'s summary output shows only the institution name and masked account identifiers (`••••3f21`) — never the access URL, in any command output, log line, or error message.
- **Never sent anywhere but the Bridge.** The only outbound calls this adapter makes are the one-time claim request and periodic `GET {accessUrl}/accounts` calls, both directly to SimpleFIN — never through a Clad-operated server (P1).

To revoke access, do it at the Bridge (`bridge.simplefin.org`) directly — that immediately invalidates the access URL Clad has stored, and the next scheduled refresh will surface a clear re-link prompt instead of failing silently.

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
