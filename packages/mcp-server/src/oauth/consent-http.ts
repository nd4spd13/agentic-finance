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
 *    delivered only via the final decision-result page (fix #5 below).
 *
 * v0.7.1 LIVE-QA HARDENING WAVE (see `.claude/plans/` release notes for the
 * full defect list). Four defects landed here (fix numbers match the PR):
 *  - **#2 bound-client consent is honest about the existing binding**: if the
 *    client already has an unrevoked `bound_profile_id`, the page preselects
 *    and LOCKS that profile (other profiles stay visible, disabled) instead
 *    of offering a choice the set-once rebind check would just refuse. If
 *    policy drift makes the bound profile no longer eligible, this renders a
 *    dead-end explaining the user must revoke — never the opaque
 *    `access_denied` redirect QA saw rendered as "No authorization code
 *    received".
 *  - **#3 stale pages self-expire**: a NEW `/authorize` for a client
 *    supersedes (removes) that client's older pending requests, so retry
 *    storms don't leave a pile of "actionable-looking" stale tabs. Each
 *    rendered page polls `GET /authorize/pending-status?state=…` every ~3s
 *    and disables itself once its request is gone.
 *  - **#4 deny sticks**: an explicit deny is remembered per client_id for
 *    `DENY_COOLDOWN_MS`; a retry within that window gets an IMMEDIATE
 *    `error=access_denied` redirect with no consent screen rendered at all,
 *    so an auto-retrying client gets a definitive answer instead of another
 *    actionable tab.
 *  - **#5 decision-result interstitial**: `POST /authorize/decision` no
 *    longer 302s straight to the client's (possibly-dead) loopback callback.
 *    It responds 200 with a small Clad-branded page that
 *    `window.location.replace()`s to the EXACT SAME redirect URL client-side
 *    — so a dead callback now shows a truthful Clad page instead of
 *    "localhost refused to connect".
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
 * v0.7.1 fix #4: how long an explicit deny "sticks" before the SAME client
 * is allowed to render a fresh consent screen again. Long enough that an
 * automated retry loop (QA finding (f): "the client just retried with more
 * tabs") gets a definitive, immediate `access_denied` on every retry instead
 * of spawning another actionable tab; short enough that an ACCIDENTAL deny
 * recovers on its own with no support path needed — the fix is "wait
 * ~90 seconds and reconnect", not "restart Clad" or "clear some cache".
 */
const DENY_COOLDOWN_MS = 90_000

/** v0.7.1 fix #3: how often a rendered consent page polls to see if it's been superseded. */
const PENDING_STATUS_POLL_MS = 3_000

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
  /**
   * v0.7.1 fix #2: the client's EXISTING unrevoked binding, if any, captured
   * at render time. When set, `renderConsentPage` locks the form to this
   * profile — never offers a choice the set-once rebind check would refuse.
   */
  boundProfileId?: string
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

/**
 * Renders the consent page: client identity (labelled untrusted), a profile
 * choice, and a per-profile scope preview. No secrets, no external resources.
 *
 * v0.7.1 fix #2: when `pending.boundProfileId` is set (the client already
 * has an unrevoked binding), the form is LOCKED to that profile — it's
 * preselected, every other profile row is rendered `disabled` (visible, for
 * transparency about what else exists, but not selectable) so the only value
 * that can ever be submitted is the one the set-once rebind check will
 * actually accept. A short notice explains why and points at the fix
 * (revoke in Connected clients).
 *
 * v0.7.1 fix #3: when the original request carried a `state`, the page
 * embeds a small polling script that checks `GET /authorize/pending-status`
 * every `PENDING_STATUS_POLL_MS` and disables itself once the server reports
 * this request has been superseded/expired — so a stale tab left open after
 * a client retry visibly and immediately tells the human it's dead, instead
 * of silently sitting there looking just as "approvable" as the live one.
 */
function renderConsentPage(pending: PendingAuthorization): string {
  const clientName = pending.consentReq.clientName
  const clientLabel = clientName ? escapeHtml(clientName) : 'An unnamed application'
  const state = pending.params.state
  const boundProfileId = pending.boundProfileId

  const profileRows = pending.consentReq.availableProfiles
    .map((profileId, index) => {
      const scopes = pending.consentReq.scopePreviewByProfile[profileId] ?? []
      const labels = scopes.length > 0 ? scopes.map((s) => `<li>${escapeHtml(scopeLabel(s))}</li>`).join('') : '<li>No permissions</li>'
      const isBoundProfile = boundProfileId !== undefined && profileId === boundProfileId
      const locked = boundProfileId !== undefined && !isBoundProfile
      const checked = boundProfileId !== undefined ? (isBoundProfile ? ' checked' : '') : index === 0 ? ' checked' : ''
      const disabledAttr = locked ? ' disabled' : ''
      return `
        <label class="profile${locked ? ' profile-locked' : ''}">
          <input type="radio" name="profile_id" value="${escapeHtml(profileId)}"${checked}${disabledAttr} required>
          <span class="profile-name">${escapeHtml(profileId)}</span>
          <ul class="scopes">${labels}</ul>
        </label>`
    })
    .join('')

  const bindingNotice =
    boundProfileId !== undefined
      ? `<p class="binding-notice">This client was previously approved as <strong>${escapeHtml(boundProfileId)}</strong>. Revoke it in Clad&apos;s <strong>Connected clients</strong> to choose differently.</p>`
      : ''

  // Fix #3: only meaningful when the original request carried a `state` —
  // that's the key `/authorize/pending-status` matches on.
  const pollScript =
    state !== undefined
      ? `
  <script>
  (function () {
    var pollState = ${JSON.stringify(state)};
    var timer = setInterval(function () {
      fetch('/authorize/pending-status?state=' + encodeURIComponent(pollState))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.status === 'gone') {
            clearInterval(timer);
            var form = document.querySelector('form');
            if (form) {
              Array.prototype.forEach.call(form.elements, function (el) { el.disabled = true; });
            }
            var actions = document.querySelector('.actions');
            if (actions) {
              actions.innerHTML = '<p class="superseded">This request was superseded by a newer one — close this tab.</p>';
            }
          }
        })
        .catch(function () {});
    }, ${PENDING_STATUS_POLL_MS});
  })();
  </script>`
      : ''

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
  .binding-notice { background: #f5f5f5; border-radius: 8px; padding: 0.75rem 1rem; font-size: 0.9rem; }
  .profile { display: block; border: 1px solid #ddd; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.5rem 0; cursor: pointer; }
  .profile-locked { opacity: 0.5; cursor: not-allowed; }
  .profile-name { font-weight: 600; margin-left: 0.4rem; }
  .scopes { margin: 0.4rem 0 0 1.6rem; padding: 0; color: #444; font-size: 0.9rem; }
  .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; }
  button { font-size: 1rem; padding: 0.6rem 1.4rem; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; }
  button[name="decision"][value="approve"] { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .superseded { color: #a33; font-weight: 600; }
</style>
</head>
<body>
  <h1>Connect to Clad</h1>
  <p><span class="client">${clientLabel}</span> wants to connect.<br>
  <span class="untrusted">(name as reported by the client — not verified)</span></p>
  ${bindingNotice}
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
  ${pollScript}
</body>
</html>`
}

/**
 * v0.7.1 fix #2 dead-end page: the client's existing bound profile is no
 * longer eligible (e.g. a policy edit removed it). Rendered INSTEAD of the
 * normal consent form — there is no valid choice this page could ever submit
 * that `finalizeApprovedAuthorization`'s set-once check would accept, so
 * offering a form at all would just reproduce the opaque
 * `access_denied` -> "No authorization code received" failure QA hit. No
 * pending request is created for this case: there is nothing to decide.
 */
function renderIneligibleBoundPage(consentReq: ConsentRequest, boundProfileId: string): string {
  const clientLabel = consentReq.clientName ? escapeHtml(consentReq.clientName) : 'An unnamed application'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connect to Clad</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  .client { font-weight: 600; }
</style>
</head>
<body>
  <h1>Can&apos;t connect right now</h1>
  <p><span class="client">${clientLabel}</span> was previously approved as <strong>${escapeHtml(boundProfileId)}</strong>, but that profile is no longer available under the current policy.</p>
  <p>Revoke this client in Clad&apos;s <strong>Connected clients</strong> list, then reconnect to choose a different profile.</p>
</body>
</html>`
}

/**
 * v0.7.1 fix #5: the decision-result page. `POST /authorize/decision` renders
 * this INSTEAD of issuing a raw `302` straight at the client's loopback
 * `redirect_uri` — if that callback listener is already dead (QA finding
 * (c)/(f): the client's proxy hung, or had already given up), a raw redirect
 * just shows the browser's own "localhost refused to connect" chrome with no
 * explanation. This page renders successfully either way (it's served by
 * Clad, not the client), tells the human what happened in plain language,
 * and then `window.location.replace()`s to the EXACT SAME redirect URL the
 * old 302 would have used — so a live callback still completes the flow
 * exactly as before, and a dead one now fails visibly and truthfully instead
 * of silently.
 */
function renderDecisionInterstitial(kind: 'approved' | 'denied', redirectUrl: string): string {
  const heading = kind === 'approved' ? 'Approved — returning you to the app…' : 'Denied — you can close this tab.'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connect to Clad</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; text-align: center; }
  h1 { font-size: 1.1rem; }
  a { color: inherit; }
</style>
</head>
<body>
  <h1>${heading}</h1>
  <p>If you are not redirected automatically, <a href="${escapeHtml(redirectUrl)}">click here</a>.</p>
  <script>window.location.replace(${JSON.stringify(redirectUrl)});</script>
</body>
</html>`
}

/** Sends the fix #5 interstitial with referrer suppression + no-store caching (the redirect URL carries a one-time auth code or definitive error — never worth caching or leaking via Referer). */
function sendDecisionInterstitial(res: Response, kind: 'approved' | 'denied', redirectUrl: string): void {
  res
    .status(200)
    .set('Referrer-Policy', 'no-referrer')
    .set('Cache-Control', 'no-store')
    .set('Pragma', 'no-cache')
    .type('html')
    .send(renderDecisionInterstitial(kind, redirectUrl))
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
  // v0.7.1 fix #4: client_id -> when it was last explicitly denied. Bounded
  // by `pruneDeniedClients` (called alongside `pruneExpired`, so it never
  // grows past however many DISTINCT clients were denied within the last
  // `DENY_COOLDOWN_MS` — old entries age out on their own).
  const deniedClients = new Map<string, number>()

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

  /** Lazily sweeps deny-cooldown entries past `DENY_COOLDOWN_MS` — keeps `deniedClients` bounded without a timer. */
  function pruneDeniedClients(): void {
    const t = now()
    for (const [clientId, deniedAt] of deniedClients) {
      if (t - deniedAt >= DENY_COOLDOWN_MS) deniedClients.delete(clientId)
    }
  }

  /**
   * v0.7.1 fix #3: a NEW `/authorize` for a client supersedes (removes) that
   * client's other still-pending requests. QA finding (d): client retries
   * opened 10-15 consent tabs, every one of them still "approvable" —
   * approving an OLDER one landed on "localhost refused to connect" because
   * the client had already moved on to a newer attempt/port. Removing the
   * old entries here means their tabs' poll (`renderConsentPage`'s script)
   * sees `'gone'` and self-disables, AND an approve/deny POST against one
   * 404s via the EXISTING unknown-request-id path — no new failure mode.
   */
  function supersedeOlderPendingForClient(clientId: string, keepRequestId: string): void {
    for (const [id, p] of pending) {
      if (id !== keepRequestId && p.consentReq.clientId === clientId) {
        pending.delete(id)
      }
    }
  }

  const consentFn: ConsentFn = async (consentReq, ctx) => {
    pruneExpired()
    pruneDeniedClients()

    // Fix #4: a client that was just explicitly denied gets an IMMEDIATE,
    // definitive `access_denied` redirect on any retry within the cooldown
    // window — no consent screen rendered, so a retry storm (QA finding (f))
    // can't accumulate more actionable tabs. Accidental-deny recovery: the
    // window is short (see `DENY_COOLDOWN_MS`'s doc comment) — wait it out
    // and reconnect; no other action needed.
    const deniedAt = deniedClients.get(consentReq.clientId)
    if (deniedAt !== undefined && now() - deniedAt < DENY_COOLDOWN_MS) {
      ctx.res.redirect(302, buildErrorRedirect(ctx.params))
      return { approved: false, reason: 'denied' }
    }

    // Fix #2: an existing (unrevoked) binding governs what this page can
    // even offer. If the bound profile fell out of eligibility (e.g. a
    // policy edit), dead-end here instead of rendering a form whose ONLY
    // possible outcome is `finalizeApprovedAuthorization`'s set-once refusal
    // — that refusal is exactly the opaque access_denied redirect QA finding
    // (a) surfaced as "No authorization code received". No pending request
    // is created: there is nothing left to decide.
    const existingBinding = deps.store.getClient(consentReq.clientId)?.boundProfileId
    if (existingBinding !== undefined && !consentReq.availableProfiles.includes(existingBinding)) {
      ctx.res.status(200).type('html').send(renderIneligibleBoundPage(consentReq, existingBinding))
      return { approved: false, reason: 'no-eligible-profile' }
    }

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
      // Only carry the binding through when it's still eligible (the
      // ineligible case already returned above) — this is what locks the
      // rendered form to a single profile.
      boundProfileId: existingBinding,
    })
    supersedeOlderPendingForClient(consentReq.clientId, requestId)

    const record = pending.get(requestId)!
    ctx.res.status(200).type('html').send(renderConsentPage(record))

    // The response above already fully answers this GET /authorize — nothing
    // in this return value is inspected by `authorize()` once `res.headersSent`
    // is true (see `provider.ts`'s `authorize()` and this file's header doc).
    return { approved: false, reason: 'denied' }
  }

  const decisionRouter = express.Router()

  /**
   * v0.7.1 fix #3: lets a rendered consent page ask "is my request still the
   * live one?". Deliberately returns ONLY the coarse `{status}` union the
   * task contract calls for — never the pending request's client name,
   * profiles, or anything else — so this endpoint can't be used to enumerate
   * or inspect in-flight authorizations, only to poll one you already hold
   * the `state` for.
   */
  decisionRouter.get('/authorize/pending-status', (req: Request, res: Response) => {
    pruneExpired()
    const state = typeof req.query.state === 'string' ? req.query.state : undefined
    const isPending = state !== undefined && Array.from(pending.values()).some((p) => p.params.state === state)
    res
      .status(200)
      .set('Cache-Control', 'no-store')
      .type('json')
      .send(JSON.stringify({ status: isPending ? 'pending' : 'gone' }))
  })

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
    // resubmission (double-click, back-button, replay, or a supersede-race)
    // 404s rather than re-processing (unchanged by v0.7.1 — the interstitial
    // below replaces only the SUCCESS response shape, never this guard).
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
      // Fix #4: remember the explicit deny so a retry within the cooldown
      // gets an immediate, definitive answer instead of another consent tab.
      deniedClients.set(record.client.client_id, now())
      // Fix #5: interstitial instead of a raw 302 — see that function's doc.
      sendDecisionInterstitial(res, 'denied', buildErrorRedirect(record.params))
      return
    }
    if (profileId === undefined || !record.assessment.eligibleProfiles.includes(profileId)) {
      sendDecisionInterstitial(res, 'denied', buildErrorRedirect(record.params))
      return
    }

    finalizeApprovedAuthorization(
      { store: deps.store, trust: deps.trust, policy: deps.policy, now: deps.now },
      record.client.client_id,
      record.assessment,
      record.params,
      profileId,
      // M3: DPoP-bound iff the client declared a DPoP key at `/authorize` —
      // recorded in the assessment's scope ceiling. Same derivation
      // `CladOAuthProvider.authorize()` uses on the fake-consent path, so the
      // two consent routes can never disagree on the binding.
      record.assessment.maxScopeSensitivity === 'high'
    )
      .then((redirect) => {
        // An approval clears any earlier deny cooldown for this client —
        // "approve for that client (possible once the window lapses) clears
        // the entry" (fix #4).
        deniedClients.delete(record.client.client_id)
        sendDecisionInterstitial(res, 'approved', redirect.href)
      })
      .catch(() => {
        // AccessDeniedError (ineligible profile / set-once bind conflict) or
        // any other failure -> a clean access_denied interstitial, never a
        // raw 500 with error internals.
        sendDecisionInterstitial(res, 'denied', buildErrorRedirect(record.params))
      })
  })

  return { consentFn, decisionRouter }
}
