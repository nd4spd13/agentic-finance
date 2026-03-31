# Clad

Consumer financial permissions middleware monorepo.

## Overview

Clad is a TypeScript-based financial permissions system that implements the default-deny principle. It provides policy-based access control for financial data across multiple agents, with support for spending limits, merchant/category restrictions, temporal scheduling, and escalation workflows.

## Structure

- **packages/core**: Core policy engine, evaluator, data providers, audit logging, and approval queue
- **packages/mcp-server**: MCP (Model Context Protocol) server integrations for Claude tools
- **packages/cli**: Command-line interface for policy management

## Development

### Requirements

- Node.js 18+
- pnpm (workspace package manager)

### Setup

```bash
pnpm install
pnpm build
pnpm test
```

### Testing

Tests are written first (TDD approach) using Vitest:

```bash
pnpm test          # Run all tests once
pnpm test:watch    # Run tests in watch mode
```

## Standards and References

- **AP2**: Spending authorization standards (limits, merchants, categories)
- **Nekuda**: Temporal scheduling and time-based rules
- **Novel**: Escalation trigger definitions
- **MCP OAuth**: Authentication and authorization
- **ACK**: Audit and compliance standards

## Key Principles

- **Default Deny**: All permissions explicitly granted, nothing implicit
- **Chain-of-Custody**: SHA-256 audit trail with tamper detection
- **ESM-Only**: All code is ES modules with explicit .js imports
- **Strict TypeScript**: Full strict mode with no any types


