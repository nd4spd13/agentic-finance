/**
 * Resolves the on-disk entry point for `@clad/mcp-server`'s stdio server.
 * Shared by the desktop app's own spawn (`mcp-server-manager.ts`, D1.2) and
 * the "Connect to Claude Desktop" config writer (`claude-desktop-
 * config.ts`, D1.4) — both need the exact same absolute path handed to a
 * `command`/`args` pair.
 *
 * S0.4 finding (see "Spike results" in packages/docs/plans/desktop-app.md):
 * resolve via ordinary Node module resolution
 * (`createRequire(import.meta.url).resolve('@clad/mcp-server')`), not the
 * CLI's relative `../../../mcp-server/dist/server.js` walk — that assumes a
 * fixed sibling-package layout that doesn't exist once packaged (only
 * `@clad/desktop`'s own `out/` + `node_modules` land in `app.asar`).
 * `@clad/mcp-server` is a normal `dependencies` entry of `@clad/desktop`, so
 * electron-builder's ordinary node_modules bundling carries it (and its own
 * `@clad/core` / `@clad/plaid-adapter` / `@modelcontextprotocol/sdk` deps)
 * into the packaged app for free — confirmed via `asar list` during S0.4.
 *
 * Pure Node module resolution, no `electron` import — safe to call from a
 * plain Vitest test.
 */

import { createRequire } from 'node:module'

export function resolveMcpServerEntry(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('@clad/mcp-server')
}
