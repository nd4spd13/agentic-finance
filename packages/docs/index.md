---
layout: home

hero:
  name: "Clad"
  text: "Financial permissions middleware for AI agents"
  tagline: "Policy-driven access control. Full audit trail. Human-in-the-loop escalation."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View Docs
      link: /policy-reference

features:
  - icon: 🛡️
    title: Policy-as-Code
    details: Define financial permissions in declarative YAML. No code changes required to adjust constraints.

  - icon: 📝
    title: Full Audit Trail
    details: Immutable, chain-hashed audit logs of every financial decision. Complete visibility into what happened and why.

  - icon: 👥
    title: HITL Approval Queue
    details: Escalate decisions to humans automatically or on-demand. Review and approve sensitive transactions in real-time.

  - icon: 🔌
    title: MCP Protocol
    details: Works with any MCP-compatible agent — Claude, GPT-based agents, or custom toolchains. Drop-in integration via the Model Context Protocol.

  - icon: ⚡
    title: Fine-Grained Control
    details: Enforce constraints at multiple levels—per-transaction, daily, weekly, monthly. Control by merchant, category, or amount.

  - icon: 🖥️
    title: Visual Policy Editor
    details: Run `clad ui` to open a local web UI with live YAML preview. Edit agents, limits, schedules, and escalation rules through a form — no YAML expertise required.

  - icon: 🏗️
    title: Standards-Aligned
    details: Spending constraints aligned with Google's Agent Payments Protocol (AP2). Time-window controls and escalation routing built on established agentic permission patterns.
---

::: warning Primary path is the desktop app
This page and its `clad …` CLI quickstart are the **developer / legacy** path. As of 2026-07, Clad ships as a local-first **Electron desktop app** (download → set keys → connect to Claude Desktop, no terminal). See the [roadmap](/roadmap) and [desktop-app plan](/plans/desktop-app). The CLI still works and remains supported for developers.
:::

## What is Clad?

Clad sits between AI agents and financial accounts, enforcing YAML-based policies that determine what actions agents can take.

**The problem:** AI agents can make financial requests, but without proper safeguards, they might spend too much, access sensitive data, or interact with unexpected merchants.

**The solution:** Clad provides:

- **Default-deny security model**: Agents can only do what policies explicitly allow
- **Multi-level constraints**: Spending limits at transaction, daily, weekly, and monthly levels
- **Merchant & category control**: Whitelist or blacklist specific merchants and spending categories
- **Human escalation**: Complex decisions bubble up to humans for review via CLI or webhooks
- **Complete auditability**: Every decision is logged with full context and chain-hashed for tamper-evidence

## Quick Start

> **CLI path (legacy).** For the desktop app, see the [desktop-app plan](/plans/desktop-app) instead — it manages the MCP server for you. The steps below are for the `clad` CLI.

Install Clad in your TypeScript project:

```bash
npm install @clad/core @clad/mcp-server

# Initialize with a default policy
clad init

# Start the MCP server
clad start --foreground
```

Define your first policy in `clad.yaml`:

```yaml
agents:
  my-agent:
    description: "My financial agent"
    permissions:
      accounts:
        visible: [checking-account]
        balance: true
      transactions:
        read: true
        amount_visibility_cap: 10000
        lookback_days: 30
      spending:
        max_per_transaction: 1000
        max_daily: 5000
        merchants:
          block:
            - high-risk-payment
      escalation:
        triggers:
          - amount_exceeds: 5000
        channel: cli
        timeout: "5m"
        default_on_timeout: deny
```

Connect any MCP-compatible agent (e.g. Claude Desktop):

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

Verify the connection:

```bash
clad status
```

## Key Features

### Visual Policy Editor
Run `clad ui` to open a local web UI at `http://localhost:3456`. Edit every policy field through a form with a live YAML preview — no YAML expertise required. Saves directly to your `policy.yaml` on disk.

### Policy-as-Code
Write financial policies in YAML. No compilation, no deployment—just commit and reload.

### Audit Trail
Every decision is recorded with timestamp, decision, agent, account, and reason. Chain-hashed for integrity.

### HITL Approval
Automatically escalate transactions above thresholds to humans. Approve or deny via CLI, webhook, or HTTP API.

### MCP Protocol
Works with any MCP-compatible agent — Claude Desktop, OpenAI-based agents, or custom toolchains. Zero integration code required.

### Standards-Aligned
- **[AP2](https://github.com/google-agentic-commerce/AP2)**: Spending constraints aligned with Google's Agent Payments Protocol (Apache 2.0)
- **Time-window controls**: Active hours, active days, timezone, and blackout date enforcement
- **Escalation framework**: Configurable triggers, approval routing, and timeout logic

## Next Steps

- **[Getting Started Guide](/getting-started)**: Step-by-step setup instructions
- **[Policy Reference](/policy-reference)**: Complete reference for all policy fields
- **[MCP Tools](/mcp-tools)**: Reference for all available MCP tools
- **[Integration Guides](/integration-guides)**: Connect Claude Desktop, OpenAI agents, or custom MCP clients
- **[Starter Policies](/starter-policies)**: Ready-to-use policy templates
- **[Architecture](/architecture)**: Deep dive into the design and security model
