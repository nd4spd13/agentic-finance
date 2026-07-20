/**
 * DPoP (RFC 9449) proof validation — the REAL implementation (D5.3 Wave 7 / M3,
 * `.claude/plans/D5.3-authenticated-agent-identity-plan.md` §10 +
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md` §5/§8). Replaces the Wave-4
 * pass-through seam.
 *
 * Posture (parent §10): **bearer-baseline, DPoP bound PER-TOKEN, gated by scope,
 * NEVER mandated server-wide.** Nothing here rejects a plain-bearer client — a
 * token without a bound `jkt` passes through completely unchanged. Enforcement
 * is per-token: a token WITH a bound `jkt` (`AuthInfo.extra.jkt`, from
 * `StoredToken.jkt`) requires a valid DPoP proof on every `/mcp` request, so a
 * bound token can never be replayed as plain Bearer (the downgrade-safe rule).
 *
 * Architectural constraint (verified during design): the SDK's
 * `OAuthServerProvider.verifyAccessToken(token)` receives ONLY the token string
 * — no request, no headers — so sender-constraint provably CANNOT live in the
 * SDK verifier. ALL DPoP validation is this hand-rolled Express middleware:
 *  - {@link dpopEnforcement} — the `/mcp` gate, mounted AFTER `requireBearerAuth`
 *    (which populates `req.auth`).
 *  - {@link dpopTokenBinding} — the `/token` gate, which validates the proof
 *    presented at issuance/refresh and stashes it in an {@link AsyncLocalStorage}
 *    context the provider's `exchange*` methods read (they, too, receive no
 *    request object — {@link getBoundDpopProof} is the side channel).
 *
 * Crypto uses Node's built-in `crypto` only (no `jose` dependency): JWK import
 * + ES256 (ECDSA P-256, `dsaEncoding: 'ieee-p1363'` for the raw r||s JWS form)
 * verification, and a hand-computed RFC 7638 JWK thumbprint.
 *
 * Nonce (RFC 9449 §8): DELIBERATELY NOT implemented. Server-issued nonces defend
 * against an attacker pre-generating proofs before compromising a client; on a
 * single-user loopback server that only serves this one OS user's own interface
 * there is no such window worth the extra round-trip and server state. The
 * freshness window + single-use `jti` replay cache below are the anti-replay
 * mechanism. Revisit only if a real remote deployment ever ships.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'

/**
 * The shape of a validated DPoP proof (M3). Returned by {@link validateDpopProof}
 * and carried through the token-endpoint {@link AsyncLocalStorage} context.
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
 * `iat` freshness window (RFC 9449 §4.3 leaves the exact value to the RS). A
 * proof is accepted iff `|now - iat| <= 300s`. On loopback the client and server
 * share a clock, so this is generous headroom, not a real skew allowance; it is
 * the outer bound on how long a captured proof stays usable, which is why the
 * `jti` replay cache TTL is tied to it (a proof older than this is rejected by
 * the `iat` check anyway, so its `jti` need not be remembered longer).
 */
const IAT_WINDOW_SEC = 300

/** Replay-cache TTL — equals the `iat` window (see above). */
const REPLAY_TTL_MS = IAT_WINDOW_SEC * 1000

/**
 * Hard cap on the replay cache. A misbehaving/hostile client cannot grow it
 * without bound: once full, the oldest entry is evicted (Map preserves insertion
 * order). 5000 * ~64 bytes/jti is trivial, and any evicted `jti` is already
 * older than everything retained, so a replay of it would fail the `iat` check
 * regardless.
 */
const REPLAY_MAX_ENTRIES = 5000

/**
 * Bounded, single-use `jti` replay cache. Eviction is (1) lazy TTL pruning on
 * every insert and (2) an oldest-first hard cap. Module-level and shared by the
 * `/mcp` and `/token` gates so a `jti` minted for one endpoint cannot be
 * replayed at the other.
 */
class ReplayCache {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  /** Returns `true` if `jti` is fresh (and records it); `false` if it is a replay. */
  checkAndRecord(jti: string, now: number): boolean {
    this.prune(now)
    const existing = this.seen.get(jti)
    if (existing !== undefined && existing > now) return false
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    this.seen.set(jti, now + this.ttlMs)
    return true
  }

  private prune(now: number): void {
    for (const [jti, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(jti)
    }
  }
}

const replayCache = new ReplayCache(REPLAY_TTL_MS, REPLAY_MAX_ENTRIES)

/**
 * The DPoP proof presented at the CURRENT `/token` request, if any and valid.
 * `dpopTokenBinding` validates the proof and runs the downstream token handler
 * inside this context; the provider's `exchangeAuthorizationCode` /
 * `exchangeRefreshToken` (which get no request object) read it via
 * {@link getBoundDpopProof}. `undefined` for a plain-bearer `/token` request.
 */
const tokenDpopContext = new AsyncLocalStorage<DpopProof>()

/** Runs `fn` with `proof` as the current `/token` DPoP context. */
export function runWithDpopProof<T>(proof: DpopProof, fn: () => T): T {
  return tokenDpopContext.run(proof, fn)
}

/** Reads the DPoP proof bound to the current `/token` request (`undefined` if bearer). */
export function getBoundDpopProof(): DpopProof | undefined {
  return tokenDpopContext.getStore()
}

/**
 * A DPoP validation failure carrying the RFC 9449 error code the response
 * should surface. `invalid_dpop_proof` = the proof itself is malformed / wrong;
 * `invalid_token` = a proof is required for this token but none was presented.
 */
export class DpopError extends Error {
  constructor(
    readonly code: 'invalid_dpop_proof' | 'invalid_token',
    message: string
  ) {
    super(message)
    this.name = 'DpopError'
  }
}

/** base64url-decodes a JWT segment to a UTF-8 string. */
function decodeSegment(segment: string): string {
  return Buffer.from(segment, 'base64url').toString('utf-8')
}

/**
 * RFC 7638 JWK thumbprint (SHA-256, base64url) for an EC public key. The
 * canonical JSON uses ONLY the required members in lexicographic order
 * (`crv`, `kty`, `x`, `y`) with no whitespace — any extra JWK member (e.g.
 * `use`, `kid`) is excluded by construction, so a client can't perturb the
 * thumbprint by decorating its JWK.
 */
export function computeJwkThumbprint(jwk: JsonWebKey): string {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof JWK must be an EC P-256 public key.')
  }
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  return createHash('sha256').update(canonical).digest('base64url')
}

/** The expected `ath` claim value for an access token: base64url(SHA-256(token ASCII)). */
export function expectedAth(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'ascii').digest('base64url')
}

/**
 * Normalizes an incoming `DPoP` header to exactly one proof string. RFC 9449
 * §4.2: a request carries at most one DPoP header; multiple is a protocol error.
 */
export function parseDpopHeader(raw: string | string[] | undefined): string {
  if (raw === undefined) {
    throw new DpopError('invalid_token', 'A DPoP proof is required for this token.')
  }
  if (Array.isArray(raw)) {
    throw new DpopError('invalid_dpop_proof', 'Exactly one DPoP header is allowed.')
  }
  if (raw.length === 0) {
    throw new DpopError('invalid_dpop_proof', 'Empty DPoP proof.')
  }
  return raw
}

/**
 * Reconstructs the DPoP `htu` for THIS request: `http://<host><path>` with the
 * query/fragment stripped (RFC 9449 §4.2). The transport is loopback-only http,
 * and `loopbackHostGuard` (http-app.ts) has already rejected any non-loopback
 * `Host`, so the scheme is always `http`.
 */
function reconstructHtu(req: Request): string {
  const host = req.headers.host ?? '127.0.0.1'
  const path = (req.originalUrl || req.url || '/').split('?')[0]
  return `http://${host}${path}`
}

/** True for the three loopback host literals, so `localhost`/`127.0.0.1`/`::1` compare equal. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/**
 * Compares a proof's claimed `htu` against the reconstructed request `htu`.
 * Path and port must match exactly; the host matches if it is byte-identical OR
 * if both sides are loopback literals (the transport aliases `localhost` and
 * `127.0.0.1`/`[::1]` to the same bound socket, so a client that computed its
 * `htu` from `localhost:PORT` while the server sees `Host: 127.0.0.1:PORT` — or
 * vice versa — must still match). Query/fragment are ignored (compared via
 * `pathname` only).
 */
function htuMatches(claimed: string, actual: string): boolean {
  let a: URL
  let b: URL
  try {
    a = new URL(claimed)
    b = new URL(actual)
  } catch {
    return false
  }
  if (a.protocol !== b.protocol) return false
  if (a.pathname !== b.pathname) return false
  if (a.port !== b.port) return false
  if (a.hostname === b.hostname) return true
  return isLoopbackHostname(a.hostname) && isLoopbackHostname(b.hostname)
}

interface ValidateDpopInput {
  /** The raw single DPoP proof JWT (already normalized via {@link parseDpopHeader}). */
  proof: string
  /** Actual request method (`htm` must equal this). */
  htm: string
  /** Reconstructed request target URI (`htu` must match this, loopback-normalized). */
  htu: string
  /**
   * Expected `ath` value when validating on `/mcp` (base64url SHA-256 of the
   * access token). `undefined` at the token endpoint, where no access token
   * exists yet and RFC 9449 §7.1 does not require `ath`.
   */
  ath?: string
  /** Current time in ms (injectable for tests). */
  now: number
}

/**
 * Validates a DPoP proof JWT per RFC 9449 §4.3. Returns the parsed proof (with
 * its computed thumbprint) or throws a {@link DpopError}. Steps:
 *  1. header: `typ === "dpop+jwt"`, `alg === "ES256"`, embedded public `jwk`;
 *  2. signature: ES256 over `header.payload` against the embedded JWK;
 *  3. `htm` equals the request method; `htu` matches the request URI;
 *  4. `iat` within the freshness window; `jti` a string, single-use (replay cache);
 *  5. `ath` equals the access-token hash when one is expected (`/mcp`).
 *
 * The thumbprint is computed from the embedded JWK; the caller compares it to
 * the token's bound `jkt`.
 */
export function validateDpopProof(input: ValidateDpopInput): DpopProof {
  const parts = input.proof.split('.')
  if (parts.length !== 3) {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof is not a well-formed JWT.')
  }
  const [headerB64, payloadB64, signatureB64] = parts

  let header: { typ?: unknown; alg?: unknown; jwk?: unknown }
  let payload: { htm?: unknown; htu?: unknown; iat?: unknown; jti?: unknown; ath?: unknown }
  try {
    header = JSON.parse(decodeSegment(headerB64)) as typeof header
    payload = JSON.parse(decodeSegment(payloadB64)) as typeof payload
  } catch {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof header/payload is not valid JSON.')
  }

  // 1. Header shape.
  if (header.typ !== 'dpop+jwt') {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof "typ" must be "dpop+jwt".')
  }
  if (header.alg !== 'ES256') {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof "alg" must be ES256.')
  }
  if (header.jwk === null || typeof header.jwk !== 'object') {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof must embed a public JWK.')
  }
  const jwk = header.jwk as JsonWebKey
  // A private key must never appear in a proof header (RFC 9449 §4.2).
  if ('d' in (jwk as Record<string, unknown>)) {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof JWK must not contain private key material.')
  }
  const jkt = computeJwkThumbprint(jwk)

  // 2. Signature over `header.payload` using the embedded key.
  let publicKey
  try {
    publicKey = createPublicKey({ key: jwk, format: 'jwk' })
  } catch {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof JWK is not a usable public key.')
  }
  let signatureOk = false
  try {
    signatureOk = cryptoVerify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64url')
    )
  } catch {
    signatureOk = false
  }
  if (!signatureOk) {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof signature verification failed.')
  }

  // 3. Bound method + target.
  if (payload.htm !== input.htm) {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof "htm" does not match the request method.')
  }
  if (typeof payload.htu !== 'string' || !htuMatches(payload.htu, input.htu)) {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof "htu" does not match the request URI.')
  }

  // 4. Freshness + single-use.
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof "iat" is missing or not a number.')
  }
  const nowSec = Math.floor(input.now / 1000)
  if (Math.abs(nowSec - payload.iat) > IAT_WINDOW_SEC) {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof "iat" is outside the freshness window.')
  }
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof "jti" is missing.')
  }
  if (!replayCache.checkAndRecord(payload.jti, input.now)) {
    throw new DpopError('invalid_dpop_proof', 'DPoP proof "jti" has already been used (replay).')
  }

  // 5. Access-token binding (`/mcp` only).
  if (input.ath !== undefined) {
    if (typeof payload.ath !== 'string' || payload.ath !== input.ath) {
      throw new DpopError('invalid_dpop_proof', 'DPoP proof "ath" does not match the access token.')
    }
  }

  return { jkt, htu: payload.htu, htm: payload.htm as string, iat: payload.iat, jti: payload.jti }
}

/** Reads `req.auth` (populated by `requireBearerAuth`) without pulling in the SDK's ambient augmentation. */
function readAuthInfo(req: Request): AuthInfo | undefined {
  return (req as Request & { auth?: AuthInfo }).auth
}

/** Reads the string `jkt` a token is bound to, if any. */
function boundJkt(auth: AuthInfo | undefined): string | undefined {
  const jkt = (auth?.extra as { jkt?: unknown } | undefined)?.jkt
  return typeof jkt === 'string' && jkt.length > 0 ? jkt : undefined
}

/** Writes an RFC 9449 §7.1 DPoP 401 with the appropriate `WWW-Authenticate` challenge. */
function rejectMcp(res: Response, error: 'invalid_dpop_proof' | 'invalid_token', description: string): void {
  res.set('WWW-Authenticate', `DPoP algs="ES256", error="${error}", error_description="${description}"`)
  res.status(401).json({ error, error_description: description })
}

/**
 * DPoP enforcement middleware for `/mcp` — mounted AFTER `requireBearerAuth`
 * (which has populated `req.auth`).
 *
 *  - Token WITHOUT a bound `jkt` (plain Bearer, today's default): pass through
 *    COMPLETELY unchanged. This is the bearer-baseline guarantee — nothing here
 *    touches a bearer request.
 *  - Token WITH a bound `jkt`: a valid DPoP proof whose thumbprint equals that
 *    `jkt` is REQUIRED, with `htm`/`htu`/`iat`/`jti`/`ath` all checked. A
 *    missing proof → 401 `invalid_token`; a present-but-invalid proof (bad
 *    signature, wrong key, `htu`/`htm`/`iat`/`ath` mismatch, or replay) → 401
 *    `invalid_dpop_proof`. This is the downgrade-safe rule: a bound token can
 *    never be presented as plain Bearer.
 */
export function dpopEnforcement(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = readAuthInfo(req)
    const jkt = boundJkt(auth)
    if (jkt === undefined || auth === undefined) {
      // Bearer token (or, defensively, no verified token): unaffected.
      next()
      return
    }

    let proof: DpopProof
    try {
      proof = validateDpopProof({
        proof: parseDpopHeader(req.headers.dpop),
        htm: req.method,
        htu: reconstructHtu(req),
        ath: expectedAth(auth.token),
        now: Date.now(),
      })
    } catch (err) {
      if (err instanceof DpopError) {
        rejectMcp(res, err.code, err.message)
        return
      }
      rejectMcp(res, 'invalid_dpop_proof', 'Invalid DPoP proof.')
      return
    }

    if (proof.jkt !== jkt) {
      rejectMcp(res, 'invalid_dpop_proof', 'DPoP proof key does not match the bound access token.')
      return
    }
    next()
  }
}

/**
 * DPoP binding middleware for `/token` — validates a proof presented at the
 * token endpoint (issuance or refresh) and stashes it in the
 * {@link tokenDpopContext} so the provider's `exchange*` methods can bind /
 * verify it. Scoped to `/token`, mounted after the confidential-client secret
 * guard.
 *
 *  - No `DPoP` header: pass through (plain Bearer issuance) — the provider then
 *    only requires a proof if the grant / refresh token is itself DPoP-bound.
 *  - A present-but-invalid proof: 400 `invalid_dpop_proof` (RFC 9449 §5), fail
 *    closed BEFORE any token is minted.
 *  - A valid proof (no `ath` expected here — no access token exists yet): run
 *    the downstream token handler inside the proof context.
 */
export function dpopTokenBinding(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.headers.dpop === undefined) {
      next()
      return
    }
    let proof: DpopProof
    try {
      proof = validateDpopProof({
        proof: parseDpopHeader(req.headers.dpop),
        htm: req.method,
        htu: reconstructHtu(req),
        now: Date.now(),
      })
    } catch (err) {
      const code = err instanceof DpopError ? err.code : 'invalid_dpop_proof'
      const description = err instanceof Error ? err.message : 'Invalid DPoP proof.'
      // The token endpoint uses 400 for a bad proof (RFC 9449 §5), unlike the
      // resource server's 401.
      res.status(400).json({ error: code, error_description: description })
      return
    }
    runWithDpopProof(proof, () => next())
  }
}
