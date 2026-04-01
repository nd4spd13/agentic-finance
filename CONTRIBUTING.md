# Contributing

## Dev Setup

Requirements: Node.js 22+, pnpm

```bash
git clone https://github.com/yourusername/clad.git
cd clad
pnpm install
pnpm build
pnpm install-cli   # links the clad binary globally
```

Or run the CLI directly without linking:

```bash
node packages/cli/dist/index.js <command>
```

## Tests

```bash
pnpm test
```

## Project Structure

- `packages/core` — policy engine, approval queue, audit logger
- `packages/cli` — `clad` CLI
- `packages/mcp-server` — MCP server
- `packages/docs` — VitePress documentation site

## Commits

Follow the convention: `type(TICKET): description`

Examples: `fix(CRS-50): ...`, `feat(CRS-42): ...`, `test(CRS-49): ...`
