/**
 * The WS4 consent boundary (D5.3 WS2 §3, §4.4 —
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md`).
 *
 * `authorize()` never renders a consent screen itself: the human approval that
 * binds a client to an agent profile is a desktop main-process decision (WS4,
 * Wave 5), reachable from the mcp-server child only through this injectable
 * seam. WS2 lands with a programmatic `ConsentFn` (auto-approve / auto-deny in
 * tests); WS4 supplies the real Electron-backed one. Keeping it an interface
 * lets WS2's flows be tested end-to-end without Electron.
 *
 * SECURITY (WS2 §10 checklist): a `ConsentRequest` carries ONLY display-safe
 * metadata (client id, untrusted client name, profile ids, scope labels) —
 * never a token, code, secret, or `code_verifier`. `requestedProfileHint` is
 * client-asserted and MUST NOT be trusted as identity: it may reorder the
 * display, never decide the binding (parent §1, D5.4 check T2(d)).
 */

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
 * The consent outcome. On approval it carries the human-chosen `profileId`
 * (server-side authority — never a client claim) and whether the token should
 * be DPoP-bound (M2: always `false`; the seam exists for M3).
 */
export type ConsentDecision =
  | { approved: true; profileId: string; dpopBound: boolean }
  | { approved: false; reason: 'denied' | 'no-eligible-profile' }

export type ConsentFn = (req: ConsentRequest) => Promise<ConsentDecision>

/**
 * The SAFE DEFAULT consent implementation: deny everything.
 *
 * Used whenever no real consent implementation is injected (e.g. the
 * mcp-server child today, before WS4's desktop consent window exists —
 * `server-core.ts`). An `/authorize` request therefore dead-ends in an
 * `access_denied` redirect rather than silently minting a grant with no human
 * in the loop. Wave 5 replaces this with the Electron-backed screen.
 */
export const denyingConsent: ConsentFn = async () => ({ approved: false, reason: 'denied' })
