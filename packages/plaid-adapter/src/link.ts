/**
 * Plaid Link connect flow (CRS-25 WP4).
 *
 * Two entry points turn a Plaid connection into a stored, encrypted access
 * token without any secret ever leaving this machine or reaching an MCP
 * client:
 *
 *  - `runLinkFlow` drives the interactive browser-based Link experience. It
 *    stands up a loopback-only HTTP server on an ephemeral port, opens the
 *    system browser to a single-use random URL that hosts Plaid Link, and
 *    waits for Link's `onSuccess`/`onExit` callbacks. On success it exchanges
 *    the `public_token` for an `access_token`, persists it via the injected
 *    `TokenStore`, and resolves with connection metadata — **never the token**.
 *
 *  - `runSandboxAutoFlow` mints a sandbox `public_token` server-side and
 *    exchanges/stores it with no browser. It refuses to run unless
 *    `PLAID_ENV=sandbox`.
 *
 * Security invariants:
 *  - The access token is never in a return value, printed, or logged.
 *  - Any dynamic error text is passed through `redactSecrets` (via
 *    `LinkFlowError`) before it can escape.
 *  - The callback server binds `127.0.0.1` only and gates every request behind
 *    a per-run random path segment so other local processes can't drive it.
 *  - The server is always closed — on success, failure, or timeout.
 *  - Once the flow has settled, every further request on the pathId (a stale
 *    page reload, a re-clicked "Open Plaid Link" button, or a request racing
 *    the socket teardown below) gets a terminal 410 and can never reach
 *    `exchangeAndStore` — the caller may already be closing the `TokenStore`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { redactSecrets, type TokenStore } from '@clad/core'
import { CountryCode, Products } from 'plaid'
import { LinkFlowError } from './errors.js'
import { getPlaidErrorCode } from './plaid-error.js'
import type { PlaidClientLike } from './plaid-client.types.js'

/** Default Plaid sandbox institution ("First Platypus Bank"). */
const DEFAULT_SANDBOX_INSTITUTION_ID = 'ins_109508'

/** Default browser-flow timeout: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * A single account surfaced by Plaid Link's `onSuccess` metadata. Carries no
 * balance or token material — just enough to show the user what they linked.
 */
export interface LinkedAccount {
  id: string
  name: string
  mask?: string
  type?: string
  subtype?: string
}

/**
 * The result of a successful connect flow. Deliberately contains NO access
 * token — the token is only ever written to the `TokenStore`.
 */
export interface LinkFlowResult {
  itemId: string
  institutionName: string
  accounts: LinkedAccount[]
}

export interface CreateLinkTokenOptions {
  /** Opaque local user id sent to Plaid (never PII). */
  clientUserId?: string
}

/**
 * Creates a `link_token` via `/link/token/create`, scoped to the
 * `transactions` product, US / English, and the "Clad" client name.
 */
export async function createLinkToken(
  client: PlaidClientLike,
  opts: CreateLinkTokenOptions = {}
): Promise<string> {
  const response = await client.linkTokenCreate({
    client_name: 'Clad',
    language: 'en',
    country_codes: [CountryCode.Us],
    products: [Products.Transactions],
    user: { client_user_id: opts.clientUserId ?? 'clad-local-user' },
  })
  return response.data.link_token
}

export interface RunLinkFlowOptions {
  client: PlaidClientLike
  tokenStore: TokenStore
  /**
   * Opens the given loopback URL in the user's browser. Injectable so tests
   * can drive the callback endpoints directly. Defaults to the platform's
   * native "open URL" command.
   */
  openBrowser?: (url: string) => void | Promise<void>
  /** Overall flow timeout; defaults to 5 minutes. */
  timeoutMs?: number
  /** Opaque local user id forwarded to `/link/token/create`. */
  clientUserId?: string
}

/**
 * Runs the interactive, browser-based Plaid Link flow end to end and resolves
 * with the linked connection's metadata once the access token has been
 * exchanged and stored. Always closes the callback server before settling.
 */
export async function runLinkFlow(options: RunLinkFlowOptions): Promise<LinkFlowResult> {
  const { client, tokenStore } = options
  const openBrowser = options.openBrowser ?? defaultOpenBrowser
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const linkToken = await createLinkToken(client, { clientUserId: options.clientUserId })
  // Single-use, unguessable path segment: other local processes that learn the
  // port still can't POST to the callback without this secret.
  const pathId = randomBytes(24).toString('hex')

  return new Promise<LinkFlowResult>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      // Stop accepting new connections immediately; in-flight responses finish.
      server.close()
      // `close()` alone leaves already-established keep-alive sockets open, so
      // a request that raced the settle could still reach the handler after
      // `settled` flips. Drop idle sockets now so as few late requests as
      // possible get the chance; the isSettled() check in handleRequest is
      // what actually guarantees a late one can't exchange a token.
      server.closeIdleConnections?.()
    }
    const succeed = (result: LinkFlowResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      handleRequest(req, res, {
        pathId,
        linkToken,
        client,
        tokenStore,
        succeed,
        fail,
        // `handler` closes over the executor's `settled` directly so the
        // request handler always sees its current value, even for a request
        // that was already in flight when succeed()/fail() ran.
        isSettled: () => settled,
      }).catch((error) => {
        respondText(res, 500, 'Internal error')
        fail(toLinkFlowError('The Plaid Link callback server errored', error))
      })
    }

    const server = createServer(handler)

    server.on('error', (error) => {
      fail(toLinkFlowError('The Plaid Link callback server could not start', error))
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const url = `http://127.0.0.1:${port}/${pathId}`
      timer = setTimeout(() => {
        fail(new LinkFlowError('Timed out waiting for the Plaid Link flow to complete.'))
      }, timeoutMs)
      // Unref so a lingering timer can't keep the process alive on its own.
      timer.unref?.()
      Promise.resolve()
        .then(() => openBrowser(url))
        .catch((error) => fail(toLinkFlowError('Failed to open the browser for Plaid Link', error)))
    })
  })
}

interface HandlerContext {
  pathId: string
  linkToken: string
  client: PlaidClientLike
  tokenStore: TokenStore
  succeed: (result: LinkFlowResult) => void
  fail: (error: Error) => void
  /** True once `succeed`/`fail` has run — see the settle-gate below. */
  isSettled: () => boolean
}

const SETTLED_MESSAGE = 'This connect session has ended. Return to the app and start a new connection.'

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext
): Promise<void> {
  const { pathId } = ctx
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const isPathIdRequest = path === `/${pathId}` || path.startsWith(`/${pathId}/`)

  // The flow settles exactly once (see succeed()/fail()). Any request that
  // lands afterward — a reloaded page, a re-clicked button using the still-
  // embedded link token, or a late request delivered over a keep-alive
  // socket that outlived server.close() — must be a dead end: it can never
  // call exchangeAndStore, since the caller may already be tearing down the
  // TokenStore it would write to.
  if (isPathIdRequest && ctx.isSettled()) {
    res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderClosePage(SETTLED_MESSAGE))
    return
  }

  if (req.method === 'GET' && path === `/${pathId}`) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderLinkPage(ctx.linkToken, pathId))
    return
  }

  if (req.method === 'POST' && path === `/${pathId}/callback`) {
    const body = await readJsonBody(req)
    try {
      const result = await exchangeAndStore(ctx.client, ctx.tokenStore, body)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderClosePage('Your account is connected. You can close this tab.'))
      ctx.succeed(result)
    } catch (error) {
      respondText(res, 500, 'Failed to complete the connection.')
      ctx.fail(toLinkFlowError('Failed to exchange the Plaid public token', error))
    }
    return
  }

  if (req.method === 'POST' && path === `/${pathId}/exit`) {
    const body = await readJsonBody(req)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderClosePage('Connection cancelled. You can close this tab.'))
    ctx.fail(new LinkFlowError(`The Plaid Link flow was exited: ${summarizeExit(body)}`))
    return
  }

  // Wrong path (including a wrong/guessed random segment) or unsupported method.
  respondText(res, 404, 'Not found')
}

/**
 * Exchanges the `public_token` from Link's `onSuccess` for an `access_token`,
 * stores it, and returns non-secret connection metadata.
 */
async function exchangeAndStore(
  client: PlaidClientLike,
  tokenStore: TokenStore,
  body: unknown
): Promise<LinkFlowResult> {
  const record = isRecord(body) ? body : {}
  const publicToken = record.public_token
  if (typeof publicToken !== 'string' || publicToken.length === 0) {
    throw new LinkFlowError('Plaid Link callback did not include a public_token.')
  }
  const metadata = isRecord(record.metadata) ? record.metadata : {}

  const exchange = await client.itemPublicTokenExchange({ public_token: publicToken })
  const { access_token, item_id } = exchange.data

  const institutionName = extractInstitutionName(metadata)
  tokenStore.saveItem({ itemId: item_id, institutionName, accessToken: access_token })

  return {
    itemId: item_id,
    institutionName,
    accounts: extractAccounts(metadata),
  }
}

export interface RunSandboxAutoFlowOptions {
  client: PlaidClientLike
  tokenStore: TokenStore
  /** Sandbox institution to create the Item against; defaults to `ins_109508`. */
  institutionId?: string
}

/**
 * Non-interactive sandbox flow: creates a sandbox `public_token`, exchanges it
 * for an `access_token`, and stores it. Refuses to run unless
 * `PLAID_ENV=sandbox` so it can never touch a real user's data.
 */
export async function runSandboxAutoFlow(
  options: RunSandboxAutoFlowOptions
): Promise<LinkFlowResult> {
  if (process.env.PLAID_ENV !== 'sandbox') {
    throw new LinkFlowError(
      'runSandboxAutoFlow requires PLAID_ENV=sandbox; refusing to run in a non-sandbox environment.'
    )
  }

  const institutionId = options.institutionId ?? DEFAULT_SANDBOX_INSTITUTION_ID

  let publicToken: string
  try {
    const created = await options.client.sandboxPublicTokenCreate({
      institution_id: institutionId,
      initial_products: [Products.Transactions],
    })
    publicToken = created.data.public_token
  } catch (error) {
    throw toLinkFlowError('Failed to create a Plaid sandbox public token', error)
  }

  let itemId: string
  let accessToken: string
  try {
    const exchange = await options.client.itemPublicTokenExchange({ public_token: publicToken })
    itemId = exchange.data.item_id
    accessToken = exchange.data.access_token
  } catch (error) {
    throw toLinkFlowError('Failed to exchange the Plaid sandbox public token', error)
  }

  const institutionName = `Sandbox Institution (${institutionId})`
  options.tokenStore.saveItem({ itemId, institutionName, accessToken })

  return { itemId, institutionName, accounts: [] }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Converts an arbitrary error into a `LinkFlowError` with a stable prefix.
 * Prefers Plaid's structured `error_code` (never secret); otherwise falls back
 * to the (redacted-by-`LinkFlowError`) message text.
 */
function toLinkFlowError(prefix: string, error: unknown): LinkFlowError {
  if (error instanceof LinkFlowError) return error
  const code = getPlaidErrorCode(error)
  if (code) return new LinkFlowError(`${prefix}: ${code}`)
  if (error instanceof Error) return new LinkFlowError(`${prefix}: ${error.message}`)
  return new LinkFlowError(`${prefix}.`)
}

/** Builds a short, secret-free description of an `onExit` payload. */
function summarizeExit(body: unknown): string {
  const record = isRecord(body) ? body : {}
  const error = isRecord(record.error) ? record.error : undefined
  const code = error && typeof error.error_code === 'string' ? error.error_code : undefined
  if (code) return redactSecrets(code)
  return 'the user closed Plaid Link before finishing.'
}

function extractInstitutionName(metadata: Record<string, unknown>): string {
  const institution = isRecord(metadata.institution) ? metadata.institution : undefined
  const name = institution && typeof institution.name === 'string' ? institution.name : undefined
  return name && name.length > 0 ? name : 'Unknown Institution'
}

function extractAccounts(metadata: Record<string, unknown>): LinkedAccount[] {
  const raw = Array.isArray(metadata.accounts) ? metadata.accounts : []
  const accounts: LinkedAccount[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id : undefined
    if (!id) continue
    accounts.push({
      id,
      name: typeof entry.name === 'string' ? entry.name : 'Account',
      mask: typeof entry.mask === 'string' ? entry.mask : undefined,
      type: typeof entry.type === 'string' ? entry.type : undefined,
      subtype: typeof entry.subtype === 'string' ? entry.subtype : undefined,
    })
  }
  return accounts
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function respondText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** JSON-encodes a value for safe embedding inside an inline <script>. */
function jsonForScript(value: unknown): string {
  // Escape `<` so a value can never break out of the <script> element.
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * Renders the loopback page that hosts Plaid Link. The link token is a
 * short-lived, non-secret token whose entire purpose is to initialize Link in
 * the browser, so embedding it here is expected. The callback/exit URLs are
 * relative to the single-use random path segment.
 */
function renderLinkPage(linkToken: string, pathId: string): string {
  const token = jsonForScript(linkToken)
  const callbackUrl = jsonForScript(`/${pathId}/callback`)
  const exitUrl = jsonForScript(`/${pathId}/exit`)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect your bank — Clad</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
  <h1>Connecting to your bank…</h1>
  <p id="status">Opening Plaid Link. If it does not appear, click the button below.</p>
  <button id="open" type="button">Open Plaid Link</button>
  <script>
    (function () {
      var LINK_TOKEN = ${token};
      var CALLBACK_URL = ${callbackUrl};
      var EXIT_URL = ${exitUrl};

      function post(url, payload) {
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      // The flow is over the moment Link exits or a callback fails: the
      // server has already settled (or is about to) and will 410 anything
      // else on this pathId. Disabling the button here stops the user from
      // re-opening Link and "completing" a connection nothing is listening
      // for anymore.
      function lockPage() {
        document.getElementById('open').disabled = true;
        document.getElementById('status').textContent =
          'This connect session has ended. Return to the app and start a new connection.';
      }

      var handler = Plaid.create({
        token: LINK_TOKEN,
        onSuccess: function (public_token, metadata) {
          document.getElementById('status').textContent = 'Finishing up…';
          post(CALLBACK_URL, { public_token: public_token, metadata: metadata })
            .then(function (res) {
              if (!res.ok) lockPage();
            })
            .catch(function () {
              // Server may already be shutting down; either way this session is over.
              lockPage();
            });
        },
        onExit: function (err, metadata) {
          post(EXIT_URL, { error: err, metadata: metadata }).catch(function () {
            /* server may already be shutting down */
          });
          // Exiting is terminal from the browser's perspective regardless of
          // whether this notification reaches the server, so lock immediately
          // rather than waiting on the network round trip.
          lockPage();
        },
      });

      document.getElementById('open').addEventListener('click', function () { handler.open(); });
      handler.open();
    })();
  </script>
</body>
</html>`
}

function renderClosePage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Clad</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
  <h1>${message}</h1>
</body>
</html>`
}

/** Opens a URL using the platform's native handler. */
function defaultOpenBrowser(url: string): void {
  const platform = process.platform
  let command: string
  let args: string[]
  if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (platform === 'win32') {
    command = 'cmd'
    // `start` treats a first quoted arg as the window title, so pass an empty one.
    args = ['/c', 'start', '', url]
  } else {
    command = 'xdg-open'
    args = [url]
  }
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
}
