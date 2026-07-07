# Contributing to Clad

Thanks for your interest in contributing. This document covers how to get set up, how we work, and what we expect in pull requests.

## Dev setup

Requirements: Node.js 22+, pnpm

```bash
git clone https://github.com/nd4spd13/agentic-finance.git
cd agentic-finance
pnpm install
pnpm build
```

Link the CLI globally so you can run `clad` during development:

```bash
pnpm install-cli
```

Or run it directly without linking:

```bash
node packages/cli/dist/index.js <command>
```

## Project structure

```
packages/
  core/           — policy engine, evaluator, audit logger, approval queue
  cli/            — clad CLI (init, validate, inspect, connect, mcp, ui)
  mcp-server/     — MCP server that exposes Clad tools to agents
  plaid-adapter/  — Plaid API integration (Sandbox): encrypted token store, Link flow, sync/cache, degradation
  docs/           — VitePress documentation site
```

## Running tests

```bash
pnpm test          # run all tests once
pnpm test:watch    # watch mode
```

Tests use [Vitest](https://vitest.dev/). We follow TDD — write tests first, then implementation.

## Making changes

1. Find or file a Github Issue for the work.
2. Create a branch using the issue ID: `{ISSUE_ID}/{kebab-case-title}`.
3. Make your changes with tests.
4. Open a pull request against `main`.

## Commit style

Follow the convention: `type(TICKET): description`

```
feat(CRS-42): add merchant wildcard matching
fix(CRS-50): handle missing schedule field gracefully
test(CRS-49): cover audit log tamper detection
docs(CRS-51): update getting-started for npm install flow
```

Types: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`

## Code style

- ESM-only — all imports use explicit `.js` extensions
- Strict TypeScript — no `any`, no `ts-ignore` without justification
- No default exports (named exports only)
- Run `pnpm lint` and `pnpm format` before pushing

## License

By contributing, you agree your contributions will be licensed under the Apache 2.0 license that covers this project.
