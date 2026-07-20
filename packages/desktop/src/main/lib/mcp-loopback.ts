/**
 * Loopback address/port helpers for the desktop app's supervised HTTP MCP
 * child (D5.3 WS1 interim fix). Shared by:
 *   - `mcp-server-manager.ts` — spawns the child on this port and probes this
 *     URL over HTTP for readiness (an unauthenticated `fetch` post-D5.3 Wave
 *     6 — see that file's READINESS & CRASH DETECTION doc comment).
 *   - `claude-desktop-config.ts` — writes an `mcp-remote` entry pointing at
 *     this URL so Claude Desktop reaches the already-unlocked child.
 *
 * PORT LIFECYCLE (design decision): a FIXED default port, overridable via
 * `CLAD_MCP_HTTP_PORT`. Fixed (not ephemeral-persisted) is the simplest robust
 * option here: the URL written into Claude Desktop's config
 * (`http://127.0.0.1:8765/mcp`) stays valid across app/child restarts with no
 * port-rediscovery handshake and no rewrite of another app's config file. The
 * desktop app is the source of truth for the actual port at runtime — it sets
 * `CLAD_MCP_HTTP_PORT` explicitly in the child's env (see `buildServerEnv`),
 * so the child never falls back to its own default; `DEFAULT_MCP_HTTP_PORT`
 * only needs to match `@clad/mcp-server`'s standalone default for consistency.
 * (Tradeoff: a fixed port can collide with another local listener; acceptable
 * for the interim beta, and D5.3's port-allocation open question §7.4 revisits
 * it.)
 *
 * Kept in `@clad/desktop` (rather than importing `@clad/mcp-server`'s
 * `http-transport.ts`) so nothing drags the mcp-server's provider/tool graph —
 * or its `main()`-on-import entry — into the Electron main bundle just for
 * three constants. `DEFAULT_MCP_HTTP_PORT` mirrors
 * `@clad/mcp-server`'s `DEFAULT_MCP_HTTP_PORT`; keep them in sync.
 */

/** Mirror of `@clad/mcp-server`'s `DEFAULT_MCP_HTTP_PORT` — keep in sync. */
export const DEFAULT_MCP_HTTP_PORT = 8765

/** SECURITY: loopback only, never a routable interface. */
export const LOOPBACK_HOST = '127.0.0.1'

export const MCP_HTTP_PATH = '/mcp'

/** Reads `CLAD_MCP_HTTP_PORT`, falling back to `DEFAULT_MCP_HTTP_PORT`. */
export function resolveMcpHttpPort(): number {
  const raw = process.env.CLAD_MCP_HTTP_PORT
  if (raw === undefined || raw === '') return DEFAULT_MCP_HTTP_PORT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MCP_HTTP_PORT
}

/** The loopback MCP URL for a given port (`http://127.0.0.1:<port>/mcp`). */
export function mcpLoopbackUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}${MCP_HTTP_PATH}`
}
