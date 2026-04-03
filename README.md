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

This creates a `clad-policy.yaml` in the current directory. Open it to set your rules — spending limits, allowed merchants, time-based restrictions, and escalation thresholds.

Start the MCP server so your agent can use the Clad tools:

```bash
clad mcp
```

Point your Claude Desktop (or other MCP-compatible client) at the server and your agent will operate within the policy you defined.

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
