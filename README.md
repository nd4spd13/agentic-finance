# Clad

**Policy-based financial permissions middleware for AI agents.**

Clad sits between your AI agent and financial APIs, enforcing spending limits, merchant restrictions, category rules, and approval workflows — all defined in a human-readable YAML policy file.

> **Demo video:** *(coming soon)*

---

> **Disclaimer:** The financial data, account numbers, transaction histories, and merchant names used in demos and examples are entirely fictional and generated for demonstration purposes. They do not represent real accounts, real transactions, or real financial institutions.

---

## Quickstart

**Requirements:** Node.js 22+

```bash
npm install -g @clad/cli
```

Initialize a policy file for your project:

```bash
clad init
```

This creates a `cpolicy.yaml` in a .clad directory. Edit it by hand, or open the visual policy editor:

```bash
clad ui
```

This starts a local web UI at `http://localhost:3456` where you can configure agents, spending limits, merchant rules, schedules, and escalation settings — with a live YAML preview and one-click save.

Save the new clad-policy file, and if needed, check it using:

```bash
clad policy validate
```

Register the MCP server with your agent (Claude Desktop, Claude Code, etc.):

```bash
# Find the full path to node — you'll need it below
node -e "process.stdout.write(process.execPath)"
```

Add Clad to your MCP config (e.g. `~/.claude/.mcp.json` for Claude Code, or `~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop):

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

> **Important:** MCP clients launch server processes with a minimal environment — `clad` and `node` may not be in PATH. Always use **full absolute paths** for both `command` and the script path in `args`. See [Getting Started](packages/docs/getting-started.md) for detailed setup instructions.

Restart your MCP client after editing the config. Your agent will now operate within the policy you defined.

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

## Packages

| Package | Description |
|---|---|
| `@clad/cli` | The `clad` CLI — init, validate, inspect, and run the MCP server |
| `@clad/core` | Policy engine, evaluator, audit logger, and approval queue |
| `@clad/mcp-server` | MCP server exposing Clad tools to AI agents |

## Documentation

Full documentation is in [`packages/docs`](packages/docs/). Run the docs site locally:

```bash
pnpm --filter @clad/docs dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0 — see [LICENSE](LICENSE).
