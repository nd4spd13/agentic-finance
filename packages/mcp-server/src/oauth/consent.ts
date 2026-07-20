/**
 * The WS4 consent boundary (D5.3 WS2 §3, §4.4 —
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md`; real implementation:
 * WS4 S3, `.claude/plans/d5.3/WS4-consent-revocation-ui.md`).
 *
 * `authorize()` never renders a consent screen itself: the human approval that
 * binds a client to an agent profile is reachable from the mcp-server child
 * only through this injectable seam. WS2 landed with a programmatic
 * `ConsentFn` (auto-approve / auto-deny in tests); WS4 S3 (`consent-http.ts`)
 * supplies the real one — a loopback-served HTML consent page rendered by the
 * child itself (the AS runs in the supervised mcp-server child, which holds
 * the passphrase/policy/grant store; a native Electron window would need a new
 * reverse main<->child channel purely to ask a question mid-HTTP-request — see
 * WS4 §2). Keeping `ConsentFn` an interface lets WS2's flows be tested
 * end-to-end without any HTTP rendering at all.
 *
 * SECURITY (WS2 §10 checklist): a `ConsentRequest` carries ONLY display-safe
 * metadata (client id, untrusted client name, profile ids, scope labels) —
 * never a token, code, secret, or `code_verifier`. `requestedProfileHint` is
 * client-asserted and MUST NOT be trusted as identity: it may reorder the
 * display, never decide the binding (parent §1, D5.4 check T2(d)).
 */

import type { Response } from 'express'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { TrustAssessment } from '@clad/core'

/** Display-safe context handed to the consent implementation. Contains no secret material. */
export interface ConsentRequest {
  /** Server-issued DCR client id — the one non-spoofable handle. */
  clientId: string
  /** Client-self-reported name (RFC 7591). UNTRUSTED display text. */
  clientName?: string
  /** A profile the client hinted at. UNTRUSTED — may reorder display, never binds. */
  requestedProfileHint?: string
  /** Profiles the client is eligible to bind to (from the trust assessment). */
  availableProfiles: string[]
  /** The scope set each available profile would be minted, for honest display. */
  scopePreviewByProfile: Record<string, string[]>
}

/**
 * Transport context handed to `ConsentFn` ALONGSIDE the display-safe
 * `ConsentRequest`. A programmatic/test `ConsentFn` can ignore this entirely
 * (TypeScript allows a callback declared with fewer parameters than its
 * function-type target — every fake `ConsentFn` in this package's tests is a
 * zero- or one-argument function and stays valid unmodified).
 *
 * This is how the REAL (interactive, WS4 S3) `ConsentFn` gets at the live
 * `res` for the pending `GET /authorize` request plus everything needed to
 * complete the authorization LATER, from a separate `POST /authorize/decision`
 * request (`consent-http.ts`): it renders the consent HTML directly onto
 * `res` and returns without an inline approval, and `CladOAuthProvider.
 * authorize()` (`provider.ts`) detects `res.headersSent` afterward and stops
 * touching `res` itself — the decision route's own `res` issues the eventual
 * redirect.
 */
export interface ConsentContext {
  res: Response
  client: OAuthClientInformationFull
  params: AuthorizationParams
  assessment: TrustAssessment
}

/**
 * The consent outcome. On approval it carries the human-chosen `profileId`
 * (server-side authority — never a client claim).
 *
 * `dpopBound` is retained for back-compat but is NO LONGER the authoritative
 * source of the grant's DPoP binding (M3, Wave 7): the human doesn't choose
 * DPoP — the CLIENT either presents a DPoP key or not. Both consent paths
 * (`provider.ts`'s fake-consent tail and `consent-http.ts`'s decision route)
 * now derive the binding from `assessment.maxScopeSensitivity === 'high'` (the
 * trust provider sets that iff the client declared a `dpop_jkt` at
 * `/authorize`), so this field is advisory only.
 */
export type ConsentDecision =
  | { approved: true; profileId: string; dpopBound: boolean }
  | { approved: false; reason: 'denied' | 'no-eligible-profile' }

export type ConsentFn = (req: ConsentRequest, ctx: ConsentContext) => Promise<ConsentDecision>

/**
 * The SAFE DEFAULT consent implementation: deny everything.
 *
 * Used whenever no real consent implementation is injected (e.g. as a
 * fallback / in tests that don't care about the human-approval path). An
 * `/authorize` request therefore dead-ends in an `access_denied` redirect
 * rather than silently minting a grant with no human in the loop. Production
 * wiring (`server-core.ts`'s `loadOAuthProvider`) now injects the real
 * `consent-http.ts` implementation instead.
 */
export const denyingConsent: ConsentFn = async () => ({ approved: false, reason: 'denied' })
