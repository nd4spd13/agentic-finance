/**
 * DPoP (RFC 9449) seam — STUBS ONLY in M2 (D5.3 WS2 §5/§8, parent §10 —
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md`).
 *
 * Posture (parent §10): **bearer-baseline, DPoP-optional, bound per-token,
 * gated by scope, NEVER mandated server-wide.** M2 issues plain Bearer tokens
 * only; this module is the placeholder Wave 7 (M3) fills in with real proof
 * validation. Nothing here mandates DPoP, and the metadata documents advertise
 * `dpop_bound_access_tokens_required: false` (see `http-app.ts`).
 *
 * The seam is already load-bearing in three places, so M3 is a drop-in:
 *  - Token records carry an optional `jkt` thumbprint column (WS5's
 *    `StoredToken.jkt`), surfaced on `AuthInfo.extra.jkt` by
 *    `verifyAccessToken`. In M2 it is always `undefined`.
 *  - `dpopEnforcement` is mounted after `requireBearerAuth` on `/mcp`, so M3
 *    only has to replace this pass-through body.
 *  - Scope sensitivity (`scope-minter.ts` `scopeSensitivity`) already gates
 *    which profiles a bearer-only client may hold at consent time.
 */

import type { RequestHandler } from 'express'

/**
 * The shape of a validated DPoP proof (M3 — Wave 7). Present now only as the
 * documented target so token records and middleware can reference it without a
 * later interface churn.
 */
export interface DpopProof {
  /** RFC 7638 SHA-256 thumbprint of the proof's public key. */
  jkt: string
  /** HTTP target URI the proof is bound to. */
  htu: string
  /** HTTP method the proof is bound to. */
  htm: string
  /** Proof issuance time (seconds since epoch). */
  iat: number
  /** Unique proof id, for replay detection. */
  jti: string
}

/**
 * DPoP enforcement middleware — a documented PASS-THROUGH in M2.
 *
 * Wave 7 (M3) replaces the body with the parent §10 rules, running AFTER
 * `requireBearerAuth` has populated `req.auth`:
 *  1. If `req.auth.extra.jkt` is set (DPoP-bound token) a valid `DPoP` proof
 *     whose thumbprint equals that `jkt` is REQUIRED — this is the
 *     downgrade-safe rule (a bound token can never be replayed as plain
 *     Bearer).
 *  2. High-sensitivity scopes are never minted onto a bearer-only grant
 *     (enforced at consent/token time in `scope-minter.ts` /
 *     `LocalConsentTrustProvider`), so this is defence-in-depth.
 *
 * In M2 no token is ever DPoP-bound (`jkt` is always `undefined`), so there is
 * nothing to enforce and this must not reject any request — mounting it now
 * only fixes the seam's position in the middleware chain for Wave 7.
 */
export function dpopEnforcement(): RequestHandler {
  return (_req, _res, next) => {
    next()
  }
}
