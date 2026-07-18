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
 * SECURITY:
 *  - Binds strictly to `127.0.0.1` (never `0.0.0.0`) — see `startHttpServer`.
 *  - Rejects any request whose `Host` header isn't a loopback literal
 *    (`isLoopbackHost`), so a browser page on another origin can't reach this
 *    server via DNS rebinding even though it's listening locally.
 *  - This interim transport is intentionally UNAUTHENTICATED on the loopback
 *    port. That is an accepted risk for the beta (same threat surface as the
 *    already-plaintext SimpleFIN cache — a local process running as the same
 *    OS user could read it directly regardless) and is closed by D5.3's
 *    OAuth 2.1 + DPoP work (`.claude/plans/D5.3-authenticated-agent-identity-plan.md`,
 *    WS2/WS3). Do NOT bolt on half-baked auth here.
 *  - Stderr/error paths go through `writeRedactedStderr`.
 *
 * LIFECYCLE: this server only works while the Clad desktop app is running —
 * the child is app-supervised. That's an accepted constraint for the interim
 * fix (documented for users in the connect flow's doc comment).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createConfiguredServer, writeRedactedStderr, type ServerResources } from './server-core.js'

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

/** The single MCP endpoint this server serves. */
export const MCP_HTTP_PATH = '/mcp'

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
 * True only for `Host` headers whose hostname is a loopback literal
 * (`127.0.0.1`, `localhost`, or `[::1]`), with or without a port. Anything
 * else (a real hostname, an external IP) is rejected — DNS-rebinding
 * protection implemented as explicit middleware (the SDK's built-in
 * `enableDnsRebindingProtection` is deprecated in favour of exactly this).
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  // Strip the port. IPv6 hosts arrive bracketed (`[::1]:8765`); handle both.
  let hostname = hostHeader
  if (hostname.startsWith('[')) {
    hostname = hostname.slice(1, hostname.indexOf(']'))
  } else if (hostname.includes(':')) {
    hostname = hostname.slice(0, hostname.lastIndexOf(':'))
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/** Writes a JSON-RPC-shaped error response (used for pre-transport rejections). */
function writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    })
  )
}

/** Reads and JSON-parses a request body; rejects on invalid JSON or an over-large body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const MAX_BODY_BYTES = 4 * 1024 * 1024 // 4 MiB — MCP tool payloads are tiny; cap to bound memory.
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')
  return raw.length === 0 ? undefined : JSON.parse(raw)
}

/**
 * Starts the loopback HTTP MCP server. Resolves once it's listening.
 *
 * Stateful sessions: each MCP client gets its own `StreamableHTTPServerTransport`
 * + `Server` (the SDK binds a `Server` 1:1 to a transport), all sharing the
 * one `resources` set. Sessions are created on an `initialize` POST and torn
 * down on transport close / DELETE.
 */
export async function startHttpServer(
  resources: ServerResources,
  opts: { port?: number; host?: string } = {}
): Promise<HttpServerHandle> {
  const requestedPort = opts.port ?? DEFAULT_MCP_HTTP_PORT
  const host = opts.host ?? LOOPBACK_HOST

  const transports = new Map<string, StreamableHTTPServerTransport>()

  const httpServer = createServer((req, res) => {
    handleHttpRequest(req, res, resources, transports).catch((err) => {
      writeRedactedStderr(`[clad server] http request error: ${err}\n`)
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, 'Internal server error')
      } else {
        res.end()
      }
    })
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

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  resources: ServerResources,
  transports: Map<string, StreamableHTTPServerTransport>
): Promise<void> {
  // DNS-rebinding guard: reject anything not addressed to a loopback Host.
  if (!isLoopbackHost(req.headers.host)) {
    writeJsonRpcError(res, 403, 'Forbidden: non-loopback Host header')
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname !== MCP_HTTP_PATH) {
    writeJsonRpcError(res, 404, `Not found. The MCP endpoint is ${MCP_HTTP_PATH}.`)
    return
  }

  const sessionId = req.headers['mcp-session-id']
  const sessionKey = Array.isArray(sessionId) ? sessionId[0] : sessionId

  // Existing session: the transport handles GET (SSE), POST, and DELETE.
  if (sessionKey && transports.has(sessionKey)) {
    await transports.get(sessionKey)!.handleRequest(req, res)
    return
  }

  // No known session. The only valid case is an `initialize` POST that opens
  // a new one; everything else is a client error.
  if (req.method !== 'POST') {
    writeJsonRpcError(res, 400, 'Bad Request: no valid session for this request')
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    writeJsonRpcError(res, 400, 'Bad Request: malformed JSON body')
    return
  }

  if (sessionKey || !isInitializeRequest(body)) {
    writeJsonRpcError(res, 400, 'Bad Request: expected an initialize request to open a new session')
    return
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport)
    },
    onsessionclosed: (id) => {
      transports.delete(id)
    },
  })
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId)
  }

  const server = createConfiguredServer(resources)
  await server.connect(transport)
  // Body already consumed above — pass it through so the transport doesn't
  // try to re-read the drained stream.
  await transport.handleRequest(req, res, body)
}
