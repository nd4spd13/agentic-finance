# scripts/

Developer helper scripts. Not part of the published packages.

## `setup-mcp.js`

Generates `.mcp.json` (project-level and user-level) with absolute paths to the
current Node binary and the `clad` MCP server entry point, so MCP clients
(Claude Code, Claude Desktop) can spawn the server reliably.

```bash
pnpm mcp:setup
```

## `plaid-inspect.mjs`

Read-only helper to eyeball the data behind a Plaid connection made with
`clad connect`. It reuses the same encrypted token store + cache DB the CLI
writes (`plaid_db`, default `~/.clad/plaid.sqlite`) and calls the real
`PlaidAdapter` — exactly the path the MCP server uses — printing accounts,
balances, recent transactions, and recurring charges. It never prints the
access token; the only network calls are to Plaid.

Requires a build first (`pnpm build`) and the same environment you connected
with — including `CLAD_TOKEN_PASSPHRASE`, which must match the passphrase used
for `clad connect`.

```bash
set -a; . ./.env.sandbox; set +a          # PLAID_* + CLAD_TOKEN_PASSPHRASE
export CLAD_CONFIG_DIR="$HOME/.clad-sandbox"   # match what you used for connect
node scripts/plaid-inspect.mjs
```
