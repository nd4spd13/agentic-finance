# Clad

**Policy-based financial permissions for AI agents.**

Clad sits between your AI agent and your finances, enforcing data access, spending limits, merchant restrictions, category rules, and approval workflows — all defined in a human-readable YAML policy file. Clad acts as your shield between your AI agents and your finances, enabling secure connectivity without the risk of exposed credentials or unfettered access.

Real bank data is available today via a [Plaid](https://plaid.com/) integration (Sandbox environment) — see the [Plaid integration guide](packages/docs/integration-guides.md#connecting-a-bank-via-plaid-sandbox) to connect an account.

> **Demo video:**
>
https://github.com/user-attachments/assets/6c3ade91-3263-442f-a339-7179045d47e0



---

> **Disclaimer:** The financial data, account numbers, transaction histories, and merchant names used in demos and examples are entirely fictional and generated for demonstration purposes. They do not represent real accounts, real transactions, or real financial institutions.

---

## Quickstart

**Requirements:** Node.js 22+, pnpm

### For developers (clone + run)

```bash
git clone https://github.com/nd4spd13/agentic-finance.git
cd agentic-finance
pnpm install && pnpm build && pnpm mcp:setup
```

`mcp:setup` generates a `.mcp.json` with the correct absolute paths for your machine. Open the project in Claude Code (or restart if already open) and approve the Clad MCP when prompted — the 5 Clad tools will be available immediately.

To customize the policy, edit `examples/policy.yaml` or run `clad init` to create your own at `~/.clad/policy.yaml`.

### For users (npm install - coming soon)

```bash
npm install -g @clad/cli
clad init
```

## Desktop app (beta)

Prefer a GUI over the CLI? The Clad desktop app (macOS, Apple Silicon + Intel) wraps the same policy engine and MCP server in a menu-bar app — tray status, an approvals inbox, and a one-click "Connect to Claude Desktop" button, no terminal required.

**This is an unsigned beta build.** A signed, notarized release is on the roadmap (see the [desktop app plan](packages/docs/plans/desktop-app.md)) but isn't ready yet, so macOS Gatekeeper will flag the app the first time you open it. The steps below are the standard, safe way to open an app you trust that isn't yet code-signed.

### Install

1. Download the latest `Clad-*.dmg` (or `Clad-*-mac.zip`) from [GitHub Releases](https://github.com/nd4spd13/agentic-finance/releases).
2. Open the DMG and drag `Clad.app` into `Applications` — or, for the `.zip`, unzip it and move `Clad.app` into `/Applications` yourself.

### Getting past Gatekeeper

The first launch will be blocked with a message like *"Clad.app cannot be opened because Apple cannot check it for malicious software."* On macOS Sequoia (15) and later, the old right-click → **Open** trick no longer bypasses this — use one of the two options below instead.

**Option A — System Settings (no terminal):**

1. Double-click `Clad.app` once. It will be blocked, but this registers the app with Gatekeeper.
2. Open **System Settings → Privacy & Security**.
3. Scroll to the **Security** section — you'll see a line like *"Clad.app was blocked to protect your Mac."* Click **Open Anyway**.
4. Launch `Clad.app` again and confirm **Open** in the dialog that appears.

**Option B — Terminal:**

```bash
xattr -d com.apple.quarantine /Applications/Clad.app
```

This strips the quarantine flag macOS attaches to anything downloaded from the internet — that flag is what triggers the Gatekeeper check in the first place. You'll need to run it again after each update, since a freshly downloaded build gets a new quarantine flag.

> **Important — credentials may need re-entry after updating.** Each unsigned build is ad-hoc signed with a fresh, unique identity, and macOS Keychain access — which backs Clad's `safeStorage`-encrypted Plaid credentials and token-store passphrase — is scoped to that identity. A newer build therefore cannot always decrypt secrets an older build wrote. Clad detects this on launch and tells the two cases apart ("can't be unlocked" vs. "not set yet") rather than failing silently, and offers a re-enter-credentials or start-fresh path either way. This is expected behavior on unsigned builds, not a bug — it goes away once signed releases (with a stable signing identity) ship.

## Initial Configuration

Clad creates a starter policy at `~/.clad/policy.yaml`. Edit it by hand, or open the visual policy editor:

```bash
clad ui
```

This starts a local web UI at `http://localhost:3456` where you can configure agents, spending limits, merchant rules, schedules, and escalation settings — with a live YAML preview and one-click save.

Validate your policy:

```bash
clad policy validate
```

Register the MCP server with your agent. For Claude on Mac, you can add Clad to your Claude Desktop config at (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "clad": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/clad/packages/cli/dist/index.js", "serve"],
      "env": {
        "CLAD_AGENT_ID": "finance-agent"
      }
    }
  }
}
```

> **Important:** MCP clients launch server processes with a minimal environment — `clad` and `node` may not be in PATH. Use **full absolute paths** for both `command` and the script in `args`. Run `node -e "process.stdout.write(process.execPath)"` to find your node path.

Restart your agent client after editing the config. Your agent will now operate within the policy you defined.

### Policy file example

```yaml
version: "1"
agents:
  - id: shopping-agent
    permissions:
      spend:
        daily_limit: 500
        per_transaction_limit: 100
      merchants:
        allow:
          - amazon.com
          - grocery-store.example
      categories:
        deny:
          - gambling
          - alcohol
      schedule:
        timezone: America/New_York
        allow_hours: "09:00-21:00"
      escalation:
        threshold: 200
        notify: owner@example.com
```
## Features
Clad includes 5 MCP tools for interfacing with your banking data:
| Tool | Purpose | Returns |
|---|---|--|
| `clad_get_balances` | Fetch account balances | Filtered list of account balances |
| `clad_get_transactions` | Fetch transaction history | Filtered list of transactions |
| `clad_safe_to_spend` | Check available spending | Available balance minus recurring obligations (future feature) |
| `clad_request_action` | Request a transaction | Allow/Deny/Escalate decision |
| `clad_audit_log` | Fetch decision audit log | List of recent decisions |


## Packages

| Package | Description |
|---|---|
| `@clad/cli` | The `clad` CLI — init, validate, inspect, connect a bank, and run the MCP server |
| `@clad/core` | Policy engine, evaluator, audit logger, and approval queue |
| `@clad/mcp-server` | MCP server exposing Clad tools to AI agents |
| `@clad/plaid-adapter` | Plaid API integration (Sandbox) — encrypted token store, sync, and graceful degradation |

## Documentation

Full documentation is in [`packages/docs`](packages/docs/). Run the docs site locally and access at http://localhost:5173/:

```bash
pnpm --filter @clad/docs dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0 — see [LICENSE](LICENSE).
