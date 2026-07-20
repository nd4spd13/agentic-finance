/**
 * The REAL WS4 S3 consent implementation: a loopback-served HTML consent page,
 * rendered by the mcp-server child itself (D5.3 WS4 S3 —
 * `.claude/plans/d5.3/WS4-consent-revocation-ui.md` §2). Replaces the
 * `denyingConsent` placeholder that `server-core.ts`'s `loadOAuthProvider` used
 * before this change.
 *
 * `createHttpConsent()` returns two things, wired together by `http-app.ts`:
 *  - `consentFn` — the {@link ConsentFn} injected into `CladOAuthProviderDeps.
 *    requestConsent`. Called from `CladOAuthProvider.authorize()` (`provider.ts`)
 *    for every `GET /authorize`. It renders the consent page DIRECTLY onto the
 *    pending response (`ctx.res`) and returns without an inline decision —
 *    `authorize()` detects `res.headersSent` afterward and stops touching that
 *    response. The actual approve/deny decision arrives LATER, from a
 *    completely separate request.
 *  - `decisionRouter` — an Express router exposing `POST /authorize/decision`,
 *    mounted by `http-app.ts` (only when OAuth is enabled). Looks up the
 *    pending request the consent page's form posts back to, validates the
 *    one-time CSRF token + the original OAuth `state`, then either approves
 *    (via `finalizeApprovedAuthorization`, the SAME function `authorize()`'s
 *    fake-consent tail uses) or denies, and issues the FINAL redirect to the
 *    client's `redirect_uri` using ITS OWN `res`.
 *
 * Why two requests instead of one: `CladOAuthProvider.authorize(client, params,
 * res)` is called by the SDK's `authorizationHandler` for `GET /authorize` and
 * only ever gets that ONE `res` — a single HTTP response can't both display an
 * HTML form (waiting on a human to click something) and later carry the
 * `302` redirect back to the client's `redirect_uri`. So `authorize()` uses
 * its `res` to render the form and stops; the form's own `POST` — a new
 * request, a new `res` — is what completes the flow.
 *
 * SECURITY (WS4 §2.2, WS2 §10 checklist):
 *  - **CSRF + state binding**: a random, single-use, per-pending-request CSRF
 *    token is embedded as a hidden form field (never a URL query string, never
 *    guessable) and compared with a constant-time hash comparison (mirrors
 *    `SqliteGrantStore.verifyClientSecret`'s discipline). The original OAuth
 *    `state` is independently re-checked. Both are required to match, or the
 *    decision is rejected outright — belt-and-braces per WS4 §2.2. The
 *    loopback-`Host` guard (`http-app.ts`, mounted first on the app) is the
 *    outer layer: no non-loopback origin reaches this route at all.
 *  - **Single-use + expiry**: a pending request is deleted from the in-memory
 *    map on its FIRST decision POST (approve or deny) and expires after a
 *    fixed TTL even if never acted on — either case 404s a replay/late
 *    resubmission. Pending records live in-memory only (never persisted): a
 *    child restart mid-consent simply requires the client to retry, which is
 *    already the accepted "only works while Clad is running" constraint
 *    (`WS2-oauth-resource-server.md` §10).
 *  - **Set-once bind**: enforced by `finalizeApprovedAuthorization`
 *    (`provider.ts`) — the SAME function `authorize()`'s fake-consent path
 *    uses — so this route can never drift from that invariant.
 *  - **No secrets**: the rendered page and every response here carry only the
 *    client's self-reported name (HTML-escaped, labelled "as reported by the
 *    client" — RFC 7591 `client_name` is attacker-controllable, WS4 §7),
 *    profile ids, and scope labels. No token, code, or client secret is ever
 *    on this page — none has been minted yet at render time, and the code is
 *    delivered only via the final `302` to the pre-registered `redirect_uri`.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import express, { type Request, type Response, type Router } from 'express'
import type { GrantStore, PolicyConfig, TrustAssessment, TrustProvider } from '@clad/core'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import { finalizeApprovedAuthorization } from './provider.js'
import type { ConsentFn, ConsentRequest } from './consent.js'

/** How long a rendered consent page stays valid before it 404s (5 minutes — ample for a human, short enough to bound memory). */
const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000

/**
 * Light-touch, display-only labels for the WS4 §2.2 "read balances, read
 * transactions..." style copy. Falls back to the raw scope string for
 * anything unlisted. WS4 §5 "scope-label polish": covers every entry in
 * `CLAD_SCOPES` (`scopes.ts`) — kept a plain hardcoded map (no per-profile
 * dynamic values like the exact lookback-days/dollar-cap the parent plan's
 * example copy shows, since those vary by policy and this map doesn't have
 * policy in scope); coverage across all four is asserted end-to-end in
 * `test/oauth/consent-http.test.ts`'s render test, not just here.
 */
const SCOPE_LABELS: Record<string, string> = {
  'clad:accounts.read': 'Read account balances',
  'clad:transactions.read': 'Read transactions',
  'clad:actions.request': 'Request spending actions',
  'clad:audit.read': 'Read the audit log',
}

interface PendingAuthorization {
  requestId: string
  csrfToken: string
  consentReq: ConsentRequest
  client: OAuthClientInformationFull
  params: AuthorizationParams
  assessment: TrustAssessment
  expiresAt: number
}

export interface HttpConsentDeps {
  store: GrantStore
  trust: TrustProvider
  policy: PolicyConfig
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number
  /** Injectable pending-request TTL for tests; defaults to 5 minutes. */
  ttlMs?: number
}

export interface HttpConsent {
  /** Inject into `CladOAuthProviderDeps.requestConsent` (`server-core.ts`). */
  consentFn: ConsentFn
  /** Mount on the Express app (only when OAuth is enabled) — exposes `POST /authorize/decision`. */
  decisionRouter: Router
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Constant-time string compare (mirrors `SqliteGrantStore.verifyClientSecret`'s discipline — never a length/content-leaking `===`). */
function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a, 'utf8').digest()
  const bh = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ah, bh)
}

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope
}

/** Renders the consent page: client identity (labelled untrusted), a profile choice, and a per-profile scope preview. No secrets, no external resources. */
function renderConsentPage(pending: PendingAuthorization): string {
  const clientName = pending.consentReq.clientName
  const clientLabel = clientName ? escapeHtml(clientName) : 'An unnamed application'
  const state = pending.params.state

  const profileRows = pending.consentReq.availableProfiles
    .map((profileId, index) => {
      const scopes = pending.consentReq.scopePreviewByProfile[profileId] ?? []
      const labels = scopes.length > 0 ? scopes.map((s) => `<li>${escapeHtml(scopeLabel(s))}</li>`).join('') : '<li>No permissions</li>'
      const checked = index === 0 ? ' checked' : ''
      return `
        <label class="profile">
          <input type="radio" name="profile_id" value="${escapeHtml(profileId)}"${checked} required>
          <span class="profile-name">${escapeHtml(profileId)}</span>
          <ul class="scopes">${labels}</ul>
        </label>`
    })
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connect to Clad</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  .client { font-weight: 600; }
  .untrusted { color: #666; font-size: 0.8rem; }
  .profile { display: block; border: 1px solid #ddd; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.5rem 0; cursor: pointer; }
  .profile-name { font-weight: 600; margin-left: 0.4rem; }
  .scopes { margin: 0.4rem 0 0 1.6rem; padding: 0; color: #444; font-size: 0.9rem; }
  .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; }
  button { font-size: 1rem; padding: 0.6rem 1.4rem; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; }
  button[name="decision"][value="approve"] { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
</style>
</head>
<body>
  <h1>Connect to Clad</h1>
  <p><span class="client">${clientLabel}</span> wants to connect.<br>
  <span class="untrusted">(name as reported by the client — not verified)</span></p>
  <p>Choose which profile to connect it as:</p>
  <form method="POST" action="/authorize/decision">
    <input type="hidden" name="request_id" value="${escapeHtml(pending.requestId)}">
    <input type="hidden" name="csrf_token" value="${escapeHtml(pending.csrfToken)}">
    ${state !== undefined ? `<input type="hidden" name="state" value="${escapeHtml(state)}">` : ''}
    ${profileRows}
    <div class="actions">
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </div>
  </form>
</body>
</html>`
}

function plainTextPage(res: Response, status: number, message: string): void {
  res.status(status).type('text/plain').send(message)
}

/** Builds the `redirect_uri?error=access_denied[&state=...]` error redirect (mirrors the SDK's own `createErrorRedirect` shaping for the cases the SDK itself never sees, because this route bypasses `authorizationHandler`). */
function buildErrorRedirect(params: AuthorizationParams): string {
  const url = new URL(params.redirectUri)
  url.searchParams.set('error', 'access_denied')
  if (params.state !== undefined) {
    url.searchParams.set('state', params.state)
  }
  return url.href
}

export function createHttpConsent(deps: HttpConsentDeps): HttpConsent {
  const pending = new Map<string, PendingAuthorization>()
  const ttlMs = deps.ttlMs ?? DEFAULT_PENDING_TTL_MS

  function now(): number {
    return deps.now?.() ?? Date.now()
  }

  /** Lazily sweeps expired pending requests — no timer to manage/tear down on a low-traffic loopback server. */
  function pruneExpired(): void {
    const t = now()
    for (const [id, p] of pending) {
      if (p.expiresAt <= t) pending.delete(id)
    }
  }

  const consentFn: ConsentFn = async (consentReq, ctx) => {
    pruneExpired()
    const requestId = randomBytes(16).toString('base64url')
    const csrfToken = randomBytes(32).toString('base64url')
    pending.set(requestId, {
      requestId,
      csrfToken,
      consentReq,
      client: ctx.client,
      params: ctx.params,
      assessment: ctx.assessment,
      expiresAt: now() + ttlMs,
    })

    const record = pending.get(requestId)!
    ctx.res.status(200).type('html').send(renderConsentPage(record))

    // The response above already fully answers this GET /authorize — nothing
    // in this return value is inspected by `authorize()` once `res.headersSent`
    // is true (see `provider.ts`'s `authorize()` and this file's header doc).
    return { approved: false, reason: 'denied' }
  }

  const decisionRouter = express.Router()
  decisionRouter.post('/authorize/decision', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined
    const requestId = typeof body?.request_id === 'string' ? body.request_id : undefined
    const csrfToken = typeof body?.csrf_token === 'string' ? body.csrf_token : undefined
    const state = typeof body?.state === 'string' ? body.state : undefined
    const decision = typeof body?.decision === 'string' ? body.decision : undefined
    const profileId = typeof body?.profile_id === 'string' ? body.profile_id : undefined

    if (requestId === undefined) {
      plainTextPage(res, 400, 'Missing consent request id.')
      return
    }
    const record = pending.get(requestId)
    // Single-use: remove on the FIRST decision regardless of outcome, so a
    // resubmission (double-click, back-button, replay) 404s rather than
    // re-processing.
    if (record !== undefined) pending.delete(requestId)

    if (record === undefined) {
      plainTextPage(res, 404, 'This consent request is no longer valid. Please retry the connection from your MCP client.')
      return
    }
    if (record.expiresAt <= now()) {
      plainTextPage(res, 404, 'This consent request has expired. Please retry the connection from your MCP client.')
      return
    }
    if (csrfToken === undefined || !constantTimeEqual(csrfToken, record.csrfToken)) {
      plainTextPage(res, 403, 'Invalid or missing CSRF token.')
      return
    }
    // Belt-and-braces re-check of the original OAuth `state` on top of the
    // CSRF token (WS4 §2.2) — only when the original request carried one.
    if (record.params.state !== undefined && state !== record.params.state) {
      plainTextPage(res, 403, 'State mismatch.')
      return
    }

    if (decision !== 'approve') {
      res.redirect(302, buildErrorRedirect(record.params))
      return
    }
    if (profileId === undefined || !record.assessment.eligibleProfiles.includes(profileId)) {
      res.redirect(302, buildErrorRedirect(record.params))
      return
    }

    finalizeApprovedAuthorization(
      { store: deps.store, trust: deps.trust, policy: deps.policy, now: deps.now },
      record.client.client_id,
      record.assessment,
      record.params,
      profileId,
      false // M2 bearer baseline — dpopBound is always false until M3.
    )
      .then((redirect) => res.redirect(302, redirect.href))
      .catch(() => {
        // AccessDeniedError (ineligible profile / set-once bind conflict) or
        // any other failure -> a clean access_denied redirect, never a raw
        // 500 with error internals.
        res.redirect(302, buildErrorRedirect(record.params))
      })
  })

  return { consentFn, decisionRouter }
}
