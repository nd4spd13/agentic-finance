/**
 * Express application for the Clad MCP loopback HTTP transport.
 *
 * Extracted out of `http-transport.ts` (D5.3 WS2 S1 — see
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md` §2.1/§3/§3.1) so a future
 * OAuth resource-server layer (`mcpAuthRouter`, `requireBearerAuth`) can be
 * mounted in front of the `/mcp` endpoint without touching the listen/close
 * lifecycle in `http-transport.ts`. The original extraction step was
 * BEHAVIOUR-IDENTICAL to the prior `node:http` implementation — no auth, no
 * `mcpAuthRouter`, no OAuth. D5.3 WS3 S1 (see
 * `.claude/plans/d5.3/WS3-resource-enforcement.md` §4) added ONE dev-only
 * placeholder — `staticBearerBridge`, active only behind
 * `CLAD_MCP_STATIC_BEARER` and `NODE_ENV!=='production'` — standing in for
 * `requireBearerAuth` until WS2 lands.
 *
 * D5.3 WS2 S2-S3 (this change) mounts the SDK's real `mcpAuthRouter` — RFC
 * 8414 + RFC 9728 metadata and RFC 7591 Dynamic Client Registration — but
 * ONLY when `resources.oauth` is set (`authRequired`, i.e.
 * `CLAD_MCP_AUTH=oauth`, plus a successfully-constructed
 * `CladOAuthProvider` — see `server-core.ts`'s `loadOAuthProvider`). When
 * `resources.oauth` is undefined (today's default), NOTHING new is
 * constructed or mounted — behaviour-identical to before this change. The
 * mounted provider's `authorize`/`token`/`verify`/`revoke` flow methods all
 * still throw a fixed not-implemented error (Wave 4); `requireBearerAuth` is
 * NOT mounted in front of `/mcp` yet (also Wave 4) — the `staticBearerBridge`
 * placeholder keeps doing that job for now.
 *
 * SECURITY (preserved unchanged from the prior `node:http` transport — see
 * `http-transport.ts`'s file header for the full threat model):
 *  - The loopback-`Host` DNS-rebinding guard (`isLoopbackHost`) is installed
 *    as the FIRST middleware on the app, ahead of every route (including the
 *    OAuth router), and returns 403 on a non-loopback `Host` header.
 *  - The `/mcp` handler keeps the exact manual "read the body once, then
 *    pass `body` through" handling that
 *    `StreamableHTTPServerTransport.handleRequest(req, res, body)` expects,
 *    including the 4 MiB body cap (`readJsonBody`). NO global
 *    `express.json()` (or any other body-parsing middleware) is installed
 *    ahead of `/mcp` — that would drain the request stream before the
 *    transport (or this handler) can read it, and would change the error
 *    shape for oversized/malformed bodies. The SDK's own auth handlers scope
 *    their OWN body parsers per-route (`express.json()` inside
 *    `clientRegistrationHandler`, `express.urlencoded()` inside
 *    `tokenHandler` — verified against `dist/esm/server/auth/handlers/*.js`
 *    in the installed 1.29.0), so mounting `mcpAuthRouter` at the app root
 *    adds no global body parser either.
 *  - Every error path is written to stderr through `writeRedactedStderr`.
 *  - `x-powered-by` is disabled on the app.
 */

import { randomUUID } from 'node:crypto'
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { createConfiguredServer, writeRedactedStderr, type ServerResources } from './server-core.js'
import { CLAD_SCOPES } from './oauth/scopes.js'
import type { CladOAuthProvider } from './oauth/provider.js'
import { dpopEnforcement } from './oauth/dpop.js'

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
 * The shape `resolvePrincipal` (`server-core.ts`) expects on `req.auth` —
 * mirrors the SDK's `AuthInfo` (`server/auth/types.d.ts`) closely enough that
 * swapping this bridge for the real `requireBearerAuth` middleware (WS2, M2)
 * is a drop-in replacement with no change to `resolvePrincipal` itself.
 */
interface StaticBearerAuthInfo {
  token: string
  clientId: string
  scopes: string[]
  extra: { profileId: string }
}

/**
 * Dev-only static-bearer bridge (D5.3 WS3 §4 — the M1 walking-skeleton
 * placeholder for WS2's real OAuth resource-server middleware).
 *
 * Parses `CLAD_MCP_STATIC_BEARER=<token>:<profileId>` ONCE at app-build time.
 * Active only when that env var is set AND `NODE_ENV !== 'production'` — this
 * must never be reachable in a production build regardless of what an
 * operator sets the env var to, because it lets anyone holding `<token>`
 * assert `<profileId>` with no real verification. It exists purely to prove
 * `resolvePrincipal`/`evaluator.ts` key off a per-request, transport-supplied
 * principal before WS2's real token verification exists.
 *
 * Non-matching or absent `Authorization` header: passes through untouched.
 * This bridge never itself 401s — `resolvePrincipal`'s `authRequired` check
 * is what enforces "no profile -> reject" once `CLAD_MCP_AUTH=oauth` is set;
 * this middleware's only job is to populate `req.auth` when the static bearer
 * matches.
 */
function staticBearerBridge(req: Request, _res: Response, next: NextFunction): void {
  const raw = process.env.CLAD_MCP_STATIC_BEARER
  if (!raw || process.env.NODE_ENV === 'production') {
    next()
    return
  }

  const sep = raw.indexOf(':')
  if (sep <= 0 || sep === raw.length - 1) {
    // Malformed config (missing `:profileId`) — never treat as a valid bridge.
    next()
    return
  }
  const expectedToken = raw.slice(0, sep)
  const profileId = raw.slice(sep + 1)

  const header = req.headers.authorization
  if (header === `Bearer ${expectedToken}`) {
    const authInfo: StaticBearerAuthInfo = {
      token: expectedToken,
      clientId: 'static',
      scopes: [],
      extra: { profileId },
    }
    // `req.auth` isn't declared on Express's `Request` type until the SDK's
    // `requireBearerAuth` module (which augments `express-serve-static-core`)
    // is part of the compiled program; this bridge stands in for that
    // middleware, so it sets the same field via a local cast instead of
    // pulling in that module just for its ambient type augmentation.
    ;(req as Request & { auth?: StaticBearerAuthInfo }).auth = authInfo
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
 * Wraps `res.json` for one path so `extra` fields get merged into whatever
 * JSON body a downstream handler ends up sending — used to advertise the
 * DPoP-optional posture (WS2 §4.1/§4.2, §5) on the two `/.well-known/*`
 * metadata documents.
 *
 * Needed because `mcpAuthRouter`'s `AuthRouterOptions` (verified against
 * `dist/esm/server/auth/router.d.ts` in the installed SDK 1.29.0) has NO
 * option to add fields to either document: `createOAuthMetadata` (AS
 * metadata, RFC 8414) and the inline protected-resource-metadata object
 * literal inside `mcpAuthMetadataRouter` (RFC 9728) are both a fixed field
 * set with nothing DPoP-shaped at all — this is a verified deviation from
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md` §4.1/§4.2, which assumed
 * these fields were reachable through the router's options. Hand-duplicating
 * either function's metadata construction would silently drift on every SDK
 * upgrade; wrapping `res.json` instead lets the SDK keep computing the base
 * document and only adds keys on top. Mounted BEFORE `mcpAuthRouter` in the
 * middleware chain (see `buildHttpApp`) so it wraps the same `res` the SDK's
 * own metadata handler ultimately writes to, then calls `next()` so that
 * handler (further down the chain) still runs.
 */
function mergeMetadataFields(extra: Record<string, unknown>) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const originalJson = res.json.bind(res)
    res.json = ((body: unknown) => {
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        return originalJson({ ...(body as Record<string, unknown>), ...extra })
      }
      return originalJson(body)
    }) as typeof res.json
    next()
  }
}

/**
 * Confidential-client secret verification guard for `/token` (D5.3 WS2 §10
 * "landmine #1", `.claude/plans/d5.3/WS2-oauth-resource-server.md`).
 *
 * `SqliteGrantStore.getClient` deliberately never returns the client secret, so
 * the SDK's own `authenticateClient` middleware (`server/auth/middleware/
 * clientAuth.js`) sees `client.client_secret === undefined` and SKIPS the secret
 * check entirely — a confidential client would otherwise be authenticated by
 * `client_id` + PKCE alone. This guard is the real check: it runs BEFORE the
 * SDK's `tokenHandler` and routes verification through
 * `CladOAuthProvider.authenticateTokenRequestClient`, which does a constant-time
 * compare inside the store (the plaintext secret never leaves that boundary).
 *
 *  - Public client (`token_endpoint_auth_method: 'none'`): `true` — PKCE alone
 *    authenticates it; no secret required.
 *  - Confidential client: requires a present, unexpired, matching secret.
 *  - Unknown client / missing `client_id`: the latter is left to the SDK's own
 *    `invalid_request` shaping; an unknown `client_id` fails closed here.
 *
 * The `express.urlencoded` mounted alongside this guard parses the form body so
 * `req.body.client_id`/`client_secret` are readable; the SDK's own
 * `express.urlencoded` inside `tokenHandler` then short-circuits on
 * `on-finished`'s already-consumed check and reuses the same parsed `req.body`
 * (verified against body-parser@2.2.2's `read.js`), so no double-parse occurs.
 * Rejections are RFC 6749 §5.2-shaped and carry a FIXED, secret-free
 * description — never the secret, token, or code.
 */
function confidentialClientSecretGuard(oauth: CladOAuthProvider): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, unknown> | undefined
    const clientId = typeof body?.client_id === 'string' ? body.client_id : undefined
    const clientSecret = typeof body?.client_secret === 'string' ? body.client_secret : undefined

    // No client_id at all: let the SDK's own request validation produce the
    // canonical `invalid_request`/`invalid_client` response shape.
    if (clientId === undefined) {
      next()
      return
    }

    if (!oauth.authenticateTokenRequestClient(clientId, clientSecret)) {
      // RFC 6749 §5.2: failed client authentication -> 401 invalid_client.
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'Client authentication failed.',
      })
      return
    }
    next()
  }
}

/**
 * Builds the Express app for the loopback HTTP MCP transport: loopback-Host
 * guard first, then (iff `resources.oauth` is set) the OAuth metadata +
 * Dynamic Client Registration router (with the confidential-client `/token`
 * secret guard in front of it), then the dev-only static-bearer bridge, then
 * (iff `resources.oauth` is set) the real `requireBearerAuth` + `dpopEnforcement`
 * chain in front of `/mcp`, then the `/mcp` session-map handler, then a
 * catch-all 404. No listening/binding happens here — that stays in
 * `http-transport.ts`'s `startHttpServer`, which resolves `opts.port` to the
 * ACTUALLY-bound port (needed for `issuerUrl`/`resourceServerUrl` below) before
 * calling this.
 */
export function buildHttpApp(resources: ServerResources, opts: { port: number }): HttpApp {
  const app = express()
  app.disable('x-powered-by')

  // DNS-rebinding guard — must run before any route handling, including the
  // OAuth router.
  app.use(loopbackHostGuard)

  // D5.3 WS2 S2-S3: mount the SDK's real OAuth metadata + DCR router. Mount
  // order (WS2 §3.1): loopback guard FIRST -> auth router -> static-bearer
  // bridge -> /mcp. Nothing here runs, and nothing is constructed, unless
  // `resources.oauth` is set (`authRequired` — see `server-core.ts`'s
  // `loadOAuthProvider`), so the flag-off path below is byte-identical to
  // before this change.
  if (resources.oauth) {
    const issuerUrl = new URL(`http://127.0.0.1:${opts.port}`)
    const resourceServerUrl = new URL(`http://127.0.0.1:${opts.port}${MCP_HTTP_PATH}`)
    // RFC 9728 serves protected-resource metadata at a PATH-SPECIFIC URL
    // derived from `resourceServerUrl` (`mcpAuthMetadataRouter`, router.js:
    // `/.well-known/oauth-protected-resource${rsPath}`) — for `resourceServerUrl
    // = .../mcp` that's `/.well-known/oauth-protected-resource/mcp`, NOT the
    // bare `/.well-known/oauth-protected-resource` WS2 §4.1 assumed. Computed
    // via the SDK's own exported helper so this can't drift from what
    // `mcpAuthRouter` actually serves.
    const prmPath = new URL(getOAuthProtectedResourceMetadataUrl(resourceServerUrl)).pathname

    app.use(
      prmPath,
      mergeMetadataFields({
        bearer_methods_supported: ['header'],
        dpop_signing_alg_values_supported: ['ES256'],
        // Never true server-wide (WS2 §4.1, parent §10) — DPoP is
        // advertise-optional, enforced per-token once M3 lands.
        dpop_bound_access_tokens_required: false,
      })
    )
    app.use(
      '/.well-known/oauth-authorization-server',
      mergeMetadataFields({ dpop_signing_alg_values_supported: ['ES256'] })
    )

    // D5.3 WS2 S5 "landmine #1": verify a confidential client's secret BEFORE
    // the SDK's `/token` handler runs (its own `authenticateClient` is a no-op
    // for us because `getClient` returns no secret). Public clients pass
    // through (PKCE authenticates them). Scoped to `/token` only — never a
    // global body parser ahead of `/mcp`.
    app.use('/token', express.urlencoded({ extended: false }), confidentialClientSecretGuard(resources.oauth))

    app.use(
      mcpAuthRouter({
        provider: resources.oauth,
        issuerUrl,
        resourceServerUrl,
        resourceName: 'Clad',
        scopesSupported: [...CLAD_SCOPES],
        // WS2 §10: a loopback single-user AS has no need for
        // `express-rate-limit`'s extra state/dependency weight — explicitly
        // disabled on every handler that accepts the option, rather than
        // keep the SDK's on-by-default rate limiting for a server that is,
        // by construction, unreachable from anywhere but this one OS user's
        // own loopback interface. (There is no single top-level `rateLimit`
        // option on `AuthRouterOptions` — verified against
        // `dist/esm/server/auth/router.d.ts`; it's per-handler via
        // `authorizationOptions`/`tokenOptions`/`clientRegistrationOptions`/
        // `revocationOptions`, each `Omit<...HandlerOptions, 'provider' |
        // 'clientsStore'>`.)
        authorizationOptions: { rateLimit: false },
        tokenOptions: { rateLimit: false },
        clientRegistrationOptions: { rateLimit: false },
        revocationOptions: { rateLimit: false },
      })
    )
  }

  // Dev-only static-bearer bridge (D5.3 WS3 §4) — after the loopback guard
  // (and the OAuth router, when mounted), before the `/mcp` route, so
  // `resolvePrincipal` sees `req.auth` for any request that reaches the
  // transport. Populates nothing when `CLAD_MCP_STATIC_BEARER` is unset or
  // `NODE_ENV==='production'`.
  app.use(staticBearerBridge)

  // D5.3 WS2 S5-S6 / WS3 S3: the REAL OAuth resource-server gate in front of
  // `/mcp`. Mounted ONLY when `resources.oauth` is set (`CLAD_MCP_AUTH=oauth`),
  // so the flag-off path stays byte-identical to before this change (no bearer
  // enforcement, the dev-only static bridge above is the only auth seam).
  //
  //  - `requireBearerAuth` verifies the token via `CladOAuthProvider.
  //    verifyAccessToken` (an opaque store lookup) and populates `req.auth`
  //    (`AuthInfo`, with `extra.profileId`) — the seam `resolvePrincipal`
  //    consumes. A missing/invalid/expired/revoked token 401s here, before any
  //    tool handler runs, with a `WWW-Authenticate` header naming the PRM URL
  //    so an MCP client (mcp-remote/Claude) knows to start the OAuth dance.
  //  - `dpopEnforcement` is a documented pass-through in M2 (bearer baseline);
  //    Wave 7 fills in the RFC 9449 proof checks. Its position in the chain
  //    (after `requireBearerAuth`, which populates `req.auth`) is fixed now so
  //    M3 is a drop-in body replacement.
  if (resources.oauth) {
    const resourceServerUrl = new URL(`http://127.0.0.1:${opts.port}${MCP_HTTP_PATH}`)
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl)
    app.use(MCP_HTTP_PATH, requireBearerAuth({ verifier: resources.oauth, resourceMetadataUrl }))
    app.use(MCP_HTTP_PATH, dpopEnforcement())
  }

  const transports = new Map<string, StreamableHTTPServerTransport>()

  app.all(MCP_HTTP_PATH, asyncHandler((req, res) => mcpEndpointHandler(req, res, resources, transports)))

  app.use((_req: Request, res: Response) => {
    writeJsonRpcError(res, 404, `Not found. The MCP endpoint is ${MCP_HTTP_PATH}.`)
  })

  return { app, transports }
}
