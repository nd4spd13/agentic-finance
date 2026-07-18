/**
 * Express application for the Clad MCP loopback HTTP transport.
 *
 * Extracted out of `http-transport.ts` (D5.3 WS2 S1 — see
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md` §2.1/§3/§3.1) so a future
 * OAuth resource-server layer (`mcpAuthRouter`, `requireBearerAuth`) can be
 * mounted in front of the `/mcp` endpoint without touching the listen/close
 * lifecycle in `http-transport.ts`. This step is BEHAVIOUR-IDENTICAL to the
 * prior `node:http` implementation it replaces — no auth is added here, no
 * `mcpAuthRouter`, no OAuth. That is later work (WS2 S2+).
 *
 * SECURITY (preserved unchanged from the prior `node:http` transport — see
 * `http-transport.ts`'s file header for the full threat model):
 *  - The loopback-`Host` DNS-rebinding guard (`isLoopbackHost`) is installed
 *    as the FIRST middleware on the app, ahead of every route, and returns
 *    403 on a non-loopback `Host` header.
 *  - The `/mcp` handler keeps the exact manual "read the body once, then
 *    pass `body` through" handling that
 *    `StreamableHTTPServerTransport.handleRequest(req, res, body)` expects,
 *    including the 4 MiB body cap (`readJsonBody`). NO global
 *    `express.json()` (or any other body-parsing middleware) is installed
 *    ahead of `/mcp` — that would drain the request stream before the
 *    transport (or this handler) can read it, and would change the error
 *    shape for oversized/malformed bodies.
 *  - Every error path is written to stderr through `writeRedactedStderr`.
 *  - `x-powered-by` is disabled on the app.
 */

import { randomUUID } from 'node:crypto'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createConfiguredServer, writeRedactedStderr, type ServerResources } from './server-core.js'

/** The single MCP endpoint this server serves. */
export const MCP_HTTP_PATH = '/mcp'

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
function writeJsonRpcError(res: Response, status: number, message: string): void {
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
async function readJsonBody(req: Request): Promise<unknown> {
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
 * DNS-rebinding guard: reject anything not addressed to a loopback `Host`.
 * Registered as the app's first middleware — see `buildHttpApp`.
 */
function loopbackHostGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isLoopbackHost(req.headers.host)) {
    writeJsonRpcError(res, 403, 'Forbidden: non-loopback Host header')
    return
  }
  next()
}

/**
 * Wraps an async Express handler so a rejected promise is routed through the
 * same redacted-stderr + 500 fallback the old `node:http` server used,
 * rather than Express 5's default (unredacted) error handling.
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    fn(req, res).catch((err: unknown) => {
      writeRedactedStderr(`[clad server] http request error: ${err}\n`)
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, 'Internal server error')
      } else {
        res.end()
      }
    })
  }
}

/**
 * Handles the `/mcp` endpoint: session-map lookup for existing sessions,
 * `initialize` handling for new ones, and dispatch into
 * `StreamableHTTPServerTransport`. MOVED (not rewritten) from the previous
 * `node:http`-based `handleHttpRequest` — the loopback-host and path-routing
 * checks it used to do are now handled by Express (`loopbackHostGuard` +
 * the `app.all(MCP_HTTP_PATH, ...)` route registration in `buildHttpApp`).
 *
 * Stateful sessions: each MCP client gets its own
 * `StreamableHTTPServerTransport` + `Server` (the SDK binds a `Server` 1:1 to
 * a transport), all sharing the one `resources` set. Sessions are created on
 * an `initialize` POST and torn down on transport close / DELETE.
 */
async function mcpEndpointHandler(
  req: Request,
  res: Response,
  resources: ServerResources,
  transports: Map<string, StreamableHTTPServerTransport>
): Promise<void> {
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

export interface HttpApp {
  app: Express
  /** Live sessions, keyed by MCP session id. Exposed so the listen/close
   *  wrapper (`http-transport.ts`) can tear them down on shutdown. */
  transports: Map<string, StreamableHTTPServerTransport>
}

/**
 * Builds the Express app for the loopback HTTP MCP transport:
 * loopback-Host guard first, then the `/mcp` session-map handler, then a
 * catch-all 404 for anything else. No listening/binding happens here — that
 * stays in `http-transport.ts`'s `startHttpServer`.
 */
export function buildHttpApp(resources: ServerResources): HttpApp {
  const app = express()
  app.disable('x-powered-by')

  // DNS-rebinding guard — must run before any route handling.
  app.use(loopbackHostGuard)

  const transports = new Map<string, StreamableHTTPServerTransport>()

  app.all(MCP_HTTP_PATH, asyncHandler((req, res) => mcpEndpointHandler(req, res, resources, transports)))

  app.use((_req: Request, res: Response) => {
    writeJsonRpcError(res, 404, `Not found. The MCP endpoint is ${MCP_HTTP_PATH}.`)
  })

  return { app, transports }
}
