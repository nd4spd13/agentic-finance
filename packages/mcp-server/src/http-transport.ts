/**
 * Streamable HTTP transport for the Clad MCP server — the loopback half of
 * the "Approach A" fix for the "Claude Desktop sees 3 dummy accounts" bug.
 *
 * Why this exists: Claude Desktop's `claude_desktop_config.json` is plaintext
 * and must never hold the SimpleFIN token-store passphrase (see
 * `packages/desktop/src/main/lib/claude-desktop-config.ts`). But the desktop
 * app itself already spawns a supervised MCP child WITH the passphrase in its
 * env (`mcp-server-manager.ts` + `mcp-server-env.ts`). If that child speaks
 * HTTP on a loopback port, Claude Desktop can reach it through `mcp-remote`
 * (a stdio↔HTTP proxy) with zero secrets in any config file:
 *
 *   Claude Desktop -> mcp-remote -> 127.0.0.1:<port>/mcp -> already-unlocked child -> real data
 *
 * Unlike stdio (one client per process lifetime), HTTP serves many clients
 * concurrently, so the desktop app's own readiness `Client` and Claude
 * Desktop's `mcp-remote` client can both be connected at once.
 *
 * This file is now just the listen/close wrapper around the Express app
 * built by `http-app.ts` (D5.3 WS2 S1 — see
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md` §2.1/§3.1). The app
 * itself (loopback guard + `/mcp` handler) moved to `http-app.ts` so a future
 * OAuth resource-server layer can mount in front of `/mcp` without touching
 * this listen/close lifecycle. This port is BEHAVIOUR-IDENTICAL to the prior
 * `node:http` implementation — no auth is added in this step.
 *
 * SECURITY:
 *  - Binds strictly to `127.0.0.1` (never `0.0.0.0`) — see `startHttpServer`.
 *  - Rejects any request whose `Host` header isn't a loopback literal
 *    (`isLoopbackHost`, now in `http-app.ts`), so a browser page on another
 *    origin can't reach this server via DNS rebinding even though it's
 *    listening locally.
 *  - This interim transport is intentionally UNAUTHENTICATED on the loopback
 *    port. That is an accepted risk for the beta (same threat surface as the
 *    already-plaintext SimpleFIN cache — a local process running as the same
 *    OS user could read it directly regardless) and is closed by D5.3's
 *    OAuth 2.1 + DPoP work (`.claude/plans/D5.3-authenticated-agent-identity-plan.md`,
 *    WS2/WS3). Do NOT bolt on half-baked auth here.
 *  - Stderr/error paths go through `writeRedactedStderr` (in `http-app.ts`).
 *
 * LIFECYCLE: this server only works while the Clad desktop app is running —
 * the child is app-supervised. That's an accepted constraint for the interim
 * fix (documented for users in the connect flow's doc comment).
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'
import { buildHttpApp, isLoopbackHost, MCP_HTTP_PATH } from './http-app.js'
import type { ServerResources } from './server-core.js'

// Re-exported unchanged for existing consumers (`test/http-transport.test.ts`
// imports `isLoopbackHost`; `MCP_HTTP_PATH` is part of this module's public
// surface). Defined in `http-app.ts` now since they're properties of the
// Express app, not the listen/close wrapper.
export { isLoopbackHost, MCP_HTTP_PATH }

/**
 * Default loopback port for the HTTP transport. Fixed (not ephemeral) so the
 * URL written into Claude Desktop's config (`http://127.0.0.1:8765/mcp`)
 * stays valid across app restarts without any port-rediscovery handshake —
 * see the "port lifecycle" note in `claude-desktop-config.ts`. Override with
 * `CLAD_MCP_HTTP_PORT` (used by tests to avoid collisions).
 */
export const DEFAULT_MCP_HTTP_PORT = 8765

/** SECURITY: loopback only. Never bind `0.0.0.0` / a routable interface. */
export const LOOPBACK_HOST = '127.0.0.1'

/**
 * Resolves the HTTP port from `CLAD_MCP_HTTP_PORT`, falling back to
 * `DEFAULT_MCP_HTTP_PORT`. Shared by the server and (in the desktop app) the
 * manager + connect flow so all three agree on one number. A value of `0`
 * asks the OS for an ephemeral port (handy in standalone tests — read the
 * actual port back from `HttpServerHandle.port`).
 */
export function resolveMcpHttpPort(): number {
  const raw = process.env.CLAD_MCP_HTTP_PORT
  if (raw === undefined || raw === '') return DEFAULT_MCP_HTTP_PORT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MCP_HTTP_PORT
}

export interface HttpServerHandle {
  /** The actually-bound port (equals the requested port unless `0` was requested). */
  port: number
  /** Tears down all live sessions and stops listening. */
  close: () => Promise<void>
}

/**
 * Starts the loopback HTTP MCP server. Resolves once it's listening.
 *
 * Builds the Express app via `buildHttpApp` (loopback guard, the OAuth
 * metadata/DCR router when `resources.oauth` is set, and `/mcp` session
 * handling) and wraps it in a plain `node:http` server so we keep explicit
 * control over bind host/port and graceful close — Express apps are just
 * request-listener functions, so composing one with `createServer` is
 * straightforward.
 *
 * D5.3 WS2 S2-S3: `buildHttpApp` needs the ACTUALLY-bound port up front —
 * mounting `mcpAuthRouter` requires an `issuerUrl`/`resourceServerUrl` that
 * embed it. `opts.port` may be `0` (an ephemeral port — the convention every
 * test in this package uses to avoid collisions), which isn't known until
 * AFTER `listen()` resolves. `createServer` normally takes its request
 * listener up front, so this binds FIRST with a thin listener that forwards
 * to a not-yet-built app, then builds the real app (now knowing the real
 * port) and assigns it before returning. `buildHttpApp` is synchronous (no
 * `await` between the port becoming known and the assignment below), so
 * there is no window in which a request could arrive to find no listener
 * assigned.
 */
export async function startHttpServer(
  resources: ServerResources,
  opts: { port?: number; host?: string } = {}
): Promise<HttpServerHandle> {
  const requestedPort = opts.port ?? DEFAULT_MCP_HTTP_PORT
  const host = opts.host ?? LOOPBACK_HOST

  // `requestListener` is genuinely reassigned once, below
  // (`requestListener = app`), AFTER the closure that reads it is already
  // created and registered with `createServer`. `let` with no initializer is
  // the only way to express "declare now (so the closure can close over a
  // stable binding), assign later (once the actual port is known)" —
  // `prefer-const`'s static write-count check treats that single deferred
  // assignment as if it were the variable's initializer (since there's no
  // literal initializer to compare it against) and recommends `const`, but
  // `const requestListener: Express | undefined` with no value is not valid
  // syntax, and inlining the assignment at declaration time is impossible
  // here (the port isn't known yet).
  // eslint-disable-next-line prefer-const
  let requestListener: Express | undefined
  const httpServer = createServer((req, res) => {
    if (!requestListener) {
      // Provably unreachable in practice (see doc comment above — the
      // assignment below happens synchronously right after `listen()`
      // resolves), but fails loudly rather than hanging the connection if
      // that invariant is ever broken by a future change.
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Server starting up' }, id: null }))
      return
    }
    requestListener(req, res)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    httpServer.once('error', onError)
    httpServer.listen(requestedPort, host, () => {
      httpServer.removeListener('error', onError)
      resolve()
    })
  })

  const port = (httpServer.address() as AddressInfo).port
  const { app, transports } = buildHttpApp(resources, { port })
  requestListener = app

  process.stderr.write(`[clad server] HTTP transport listening on http://${host}:${port}${MCP_HTTP_PATH}\n`)

  return {
    port,
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close().catch(() => undefined)
      }
      transports.clear()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}
