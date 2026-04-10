# Clad

**Policy-based financial permissions for AI agents.**

Clad sits between your AI agent and your finances, enforcing data access, spending limits, merchant restrictions, category rules, and approval workflows — all defined in a human-readable YAML policy file. Clad acts as your shield between your AI agents and your finances, enabling secure connectivity without the risk of exposed credentials or unfettered access.

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
| `clad_safe_to_spend` | Check available spending | Available balance minus recurring obligations *future feature* |
| `clad_request_action` | Request a transaction | Allow/Deny/Escalate decision |
| `clad_audit_log` | Fetch decision audit log | List of recent decisions |


## Packages

| Package | Description |
|---|---|
| `@clad/cli` | The `clad` CLI — init, validate, inspect, and run the MCP server |
| `@clad/core` | Policy engine, evaluator, audit logger, and approval queue |
| `@clad/mcp-server` | MCP server exposing Clad tools to AI agents |

## Documentation

Full documentation is in [`packages/docs`](packages/docs/). Run the docs site locally and access at http://localhost:5173/:

```bash
pnpm --filter @clad/docs dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0 — see [LICENSE](LICENSE).
