/**
 * `CladOAuthProvider` — Clad's `OAuthServerProvider` implementation (D5.3
 * WS2, `.claude/plans/d5.3/WS2-oauth-resource-server.md`).
 *
 * Waves S2-S3 landed the REAL DCR `clientsStore` over `SqliteGrantStore`.
 * Wave 4 (S4-S6) implemented the six flow methods for real. Wave 5 (WS4 S3,
 * `.claude/plans/d5.3/WS4-consent-revocation-ui.md`) replaced the
 * deny-by-default `ConsentFn` with a real loopback-served consent page
 * (`consent-http.ts`) and extracted `authorize()`'s post-consent logic into
 * the standalone {@link finalizeApprovedAuthorization} below it (see that
 * function's doc comment for why):
 *  - `authorize` — authorization-code flow with S256 PKCE. The human consent
 *    step routes through an injectable {@link ConsentFn} seam (`consent-http.ts`
 *    supplies the real HTML consent screen; a safe deny-by-default is used
 *    when none is injected). Client eligibility + scope ceiling route through
 *    the `TrustProvider` (WS7). For the real interactive `ConsentFn`, which
 *    renders directly onto `res` and answers the decision LATER from a
 *    separate `POST /authorize/decision` request, `authorize()` detects
 *    `res.headersSent` and stops — `finalizeApprovedAuthorization` (called
 *    from `consent-http.ts` on approval) does the rest. For a fake/test
 *    `ConsentFn` that resolves inline, `authorize()`'s own tail calls the
 *    SAME function and persists the grant + single-use auth code, redirecting
 *    with `code`+`state`.
 *  - `challengeForAuthorizationCode` — returns the stored S256 challenge (a
 *    non-consuming peek) so the SDK's token handler can verify `code_verifier`.
 *  - `exchangeAuthorizationCode` — single-use code redemption (replay + expiry
 *    rejected), scope re-used from the grant (never a client-supplied scope),
 *    opaque access + refresh tokens issued.
 *  - `exchangeRefreshToken` — refresh rotation (old refresh invalidated), scope
 *    re-minted from the grant's ORIGINAL assessment (client `scopes` arg
 *    IGNORED).
 *  - `verifyAccessToken` — opaque store lookup returning the SDK `AuthInfo`
 *    whose `extra.profileId` is the seam WS3's `resolvePrincipal` consumes.
 *  - `revokeToken` — deletes the presented token; the live `verifyAccessToken`
 *    lookup then rejects the very next request (acceptance #3 mechanism).
 *
 * DPoP posture (parent §10, M3 — Wave 7): bearer-baseline, bound PER-TOKEN,
 * NEVER mandated. A token is plain Bearer unless the client presented a DPoP
 * proof at `/token`, in which case the proof's RFC 7638 thumbprint is bound into
 * `StoredToken.jkt` (access + refresh) and surfaced on `AuthInfo.extra.jkt`,
 * which `dpop.ts`'s `/mcp` gate then enforces on every request. High-sensitivity
 * scopes are gated on DPoP at `/authorize` (a client that declares a `dpop_jkt`
 * is assessed `maxScopeSensitivity: 'high'`); such a grant records
 * `dpopBound: true`, and `exchangeAuthorizationCode`/`exchangeRefreshToken`
 * REQUIRE a matching proof at `/token` so a high-scope grant can never downgrade
 * to a bearer token. The DPoP proof reaches these methods (which get no request
 * object) via `dpop.ts`'s `getBoundDpopProof()` async-context side channel.
 *
 * SECURITY (WS2 §10 checklist): opaque tokens are `randomBytes(32)` base64url,
 * stored ONLY as SHA-256 hashes (WS5); no token / code / secret / passphrase
 * is ever interpolated into a thrown message — every rejection uses a fixed,
 * secret-free SDK `OAuthError` subclass, which the SDK handlers shape into RFC
 * 6749 §5.2 JSON.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Response } from 'express'
import type {
  AgentIdentityClaim,
  GrantStore,
  PolicyConfig,
  StoredClient,
  TrustAssessment,
  TrustProvider,
} from '@clad/core'
import type { ConsentFn, ConsentRequest } from './consent.js'
import { getBoundDpopProof } from './dpop.js'

/** Single-use PKCE authorization code lifetime (WS2 §10: 60s). */
const AUTH_CODE_TTL_MS = 60_000
/** Access-token lifetime (WS2 §10: short, refresh-backed). */
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
/** Refresh-token lifetime — rotated on every use (WS5 §8). */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Opaque token/code generator shared by every mint site in this module. */
function mintOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Dependencies {@link finalizeApprovedAuthorization} needs — a subset of
 * {@link CladOAuthProviderDeps} (no `requestConsent`: this function only ever
 * runs AFTER a decision is already approved).
 */
export interface FinalizeAuthorizationDeps {
  store: GrantStore
  trust: TrustProvider
  policy: PolicyConfig
  now?: () => number
}

/**
 * Turns an APPROVED consent decision into a persisted grant + single-use auth
 * code + success redirect URL (steps that used to live inline at the tail of
 * `authorize()`, extracted in WS4 S3 —
 * `.claude/plans/d5.3/WS4-consent-revocation-ui.md`).
 *
 * Shared by two callers, which is the entire reason this is a standalone
 * function rather than a private method:
 *  - `CladOAuthProvider.authorize()`'s tail, for a fake/test `ConsentFn` that
 *    resolves inline within the SAME `GET /authorize` response (unchanged
 *    behaviour from Wave 4 — this is a pure extraction for that path).
 *  - `consent-http.ts`'s `POST /authorize/decision` route, for the REAL
 *    interactive consent flow, where the decision arrives from a SEPARATE
 *    HTTP request (a different `res`) potentially minutes after `authorize()`
 *    already returned. One implementation means acceptance #1's set-once
 *    binding and WS2 §6's server-only scope minting can never drift between
 *    the two paths.
 *
 * Re-checks profile eligibility and the set-once client→profile binding
 * itself (defence-in-depth against a caller that skips those checks) and
 * throws `AccessDeniedError` — never the store's raw error — on either
 * failure. Never called for a deny.
 */
export async function finalizeApprovedAuthorization(
  deps: FinalizeAuthorizationDeps,
  clientId: string,
  assessment: TrustAssessment,
  params: { redirectUri: string; codeChallenge: string; state?: string },
  profileId: string,
  dpopBound: boolean
): Promise<URL> {
  // Defence-in-depth: consent can never select a profile the trust layer
  // didn't deem eligible (parent §1 — the binding is a server decision).
  if (!assessment.eligibleProfiles.includes(profileId)) {
    throw new AccessDeniedError('Selected profile is not eligible for this client.')
  }
  // Enforce the set-once client→profile binding (acceptance #1) with a clean
  // access_denied rather than the store's raw throw.
  const existingBinding = deps.store.getClient(clientId)?.boundProfileId
  if (existingBinding !== undefined && existingBinding !== profileId) {
    throw new AccessDeniedError('Client is already bound to a different profile.')
  }

  // Mint the granted scope for the bound profile (never client-supplied).
  const scopes = await deps.trust.mintScopes({ profileId, policy: deps.policy, assessment })

  // Persist the binding + the consented grant + a single-use auth code.
  deps.store.bindClientProfile(clientId, profileId)
  const grant = deps.store.createGrant({
    clientId,
    profileId,
    scopes,
    // M3: true iff the client declared a DPoP key at `/authorize` (callers pass
    // `assessment.maxScopeSensitivity === 'high'`, which the local trust
    // provider sets iff `dpopJkt` was present). A `dpopBound` grant REQUIRES a
    // matching proof at `/token` (see `exchangeAuthorizationCode`).
    dpopBound,
    assuranceLevel: assessment.assuranceLevel,
    maxScopeSensitivity: assessment.maxScopeSensitivity,
  })
  const code = mintOpaqueToken()
  const now = deps.now?.() ?? Date.now()
  deps.store.putAuthCode({
    code,
    grantId: grant.grantId,
    codeChallenge: params.codeChallenge, // S256; the SDK verified the method upstream
    redirectUri: params.redirectUri,
    expiresAt: now + AUTH_CODE_TTL_MS,
  })

  // Build the success redirect (code + state if present). The caller decides
  // whether/how to send it — `authorize()`'s tail and the decision route each
  // own a different `res`.
  const redirect = new URL(params.redirectUri)
  redirect.searchParams.set('code', code)
  if (params.state !== undefined) {
    redirect.searchParams.set('state', params.state)
  }
  return redirect
}

export interface CladOAuthProviderDeps {
  /** WS5's grant store — registered clients, consented grants, auth codes, tokens. */
  store: GrantStore
  /** Scope source (never the client) + eligible-profile list — read at consent/token time. */
  policy: PolicyConfig
  /** WS7 seam: client assessment + scope minting (narrow-never-widen). */
  trust: TrustProvider
  /** WS4 seam: the human consent decision. Defaults to deny when unset (see `server-core.ts`). */
  requestConsent: ConsentFn
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number
}

/**
 * Maps the SDK's `token_endpoint_auth_method` onto the restricted set WS2 §10
 * supports (`'none' | 'client_secret_post'`). The actual discriminator is
 * whether the SDK generated a secret for this registration (present secret ⇒
 * `'client_secret_post'`, absent ⇒ `'none'`), not the client's self-reported
 * string.
 */
function resolveAuthMethod(clientSecret: string | undefined): StoredClient['tokenEndpointAuthMethod'] {
  return clientSecret ? 'client_secret_post' : 'none'
}

/**
 * Maps a `StoredClient` (WS5) back onto the SDK's `OAuthClientInformationFull`
 * shape. `passthrough` carries request-only DCR metadata the store doesn't
 * persist but RFC 7591 expects echoed back on registration.
 */
function toClientInformationFull(
  stored: StoredClient,
  clientSecret: string | undefined,
  passthrough: Partial<OAuthClientInformationFull> = {}
): OAuthClientInformationFull {
  return {
    ...passthrough,
    client_id: stored.clientId,
    client_id_issued_at: stored.clientIdIssuedAt,
    client_secret: clientSecret,
    client_secret_expires_at: stored.clientSecretExpiresAt,
    redirect_uris: stored.redirectUris,
    token_endpoint_auth_method: stored.tokenEndpointAuthMethod,
    client_name: stored.clientName,
  }
}

export class CladOAuthProvider implements OAuthServerProvider {
  constructor(private readonly deps: CladOAuthProviderDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** SHA-256 hex of an opaque token — matches `SqliteGrantStore`'s hashing so lookups align. */
  private hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex')
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => {
        const stored = this.deps.store.getClient(clientId)
        if (!stored) return undefined
        // The store never returns the client secret on read (write-only from
        // its perspective) — confidential-client secret verification at /token
        // goes through `authenticateTokenRequestClient` instead (WS2 §10
        // "landmine #1": the SDK's own `authenticateClient` check is a no-op
        // here precisely because this returns no secret).
        return toClientInformationFull(stored, undefined)
      },
      registerClient: (client) => {
        const stored = this.deps.store.registerClient({
          clientName: client.client_name,
          redirectUris: client.redirect_uris,
          tokenEndpointAuthMethod: resolveAuthMethod(client.client_secret),
          clientSecretExpiresAt: client.client_secret_expires_at,
          clientSecret: client.client_secret,
        })
        // Echo the SDK-generated secret back ONCE (the store only ever persists
        // it encrypted and never returns it); spread `client` as passthrough so
        // request-only DCR metadata round-trips.
        return toClientInformationFull(stored, client.client_secret, client)
      },
    }
  }

  /**
   * Confidential-client secret verification for the `/token` endpoint (WS2 §10
   * "landmine #1"). `SqliteGrantStore.getClient` never surfaces the secret, so
   * the SDK's built-in `authenticateClient` middleware is a no-op for
   * confidential clients — the real check lives here and is mounted as a
   * dedicated `/token` guard in `http-app.ts`.
   *
   *  - Public client (`token_endpoint_auth_method: 'none'`): authenticated by
   *    PKCE alone — always returns `true` (no secret to verify).
   *  - Confidential client: requires a present, unexpired, constant-time-equal
   *    secret (the comparison happens inside the store).
   *  - Unknown client: `false`.
   */
  authenticateTokenRequestClient(clientId: string, clientSecret: string | undefined): boolean {
    const stored = this.deps.store.getClient(clientId)
    if (!stored) return false
    if (stored.tokenEndpointAuthMethod !== 'client_secret_post') return true // public: PKCE only
    if (
      stored.clientSecretExpiresAt !== undefined &&
      stored.clientSecretExpiresAt < Math.floor(this.now() / 1000)
    ) {
      return false
    }
    return this.deps.store.verifyClientSecret(clientId, clientSecret)
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // 1. Trust assessment (WS7) — BEFORE any consent screen. A client declares
    //    its DPoP intent via the RFC 9449 §10 `dpop_jkt` authorization request
    //    parameter (the thumbprint of the key it will prove possession of at
    //    `/token`). The SDK's `AuthorizationParams` doesn't surface it and
    //    `authorize()` gets no request object, so we read it off the live
    //    request via `res.req` (Express's public back-reference — the same
    //    coupling `res.headersSent` below already relies on). A test's fake
    //    `res` has no `req`, so `dpopJkt` is `undefined` there (bearer). When
    //    present, the local trust provider assesses `maxScopeSensitivity: 'high'`,
    //    so this client can be minted the action-bearing scope; absent, it is
    //    capped at 'low'.
    const dpopJkt = readDpopJktParam(res)
    const claim: AgentIdentityClaim = {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUris: client.redirect_uris,
      ...(dpopJkt !== undefined ? { dpopJkt } : {}),
    }
    const assessment = await this.deps.trust.assessClient(claim)
    if (assessment.assuranceLevel === 'none' || assessment.eligibleProfiles.length === 0) {
      // No eligible profile — refuse without rendering consent (WS7 §4).
      throw new AccessDeniedError('No eligible profile for this client.')
    }

    // 2. Build the display-safe consent request: a scope preview per eligible
    //    profile, minted through the trust ceiling (so a bearer client sees the
    //    NARROWED set it would actually get).
    const scopePreviewByProfile: Record<string, string[]> = {}
    for (const profileId of assessment.eligibleProfiles) {
      scopePreviewByProfile[profileId] = await this.deps.trust.mintScopes({
        profileId,
        policy: this.deps.policy,
        assessment,
      })
    }
    const consentReq: ConsentRequest = {
      clientId: client.client_id,
      clientName: client.client_name,
      // The client's requested scope hint is display-only; never trusted as identity.
      requestedProfileHint: undefined,
      availableProfiles: assessment.eligibleProfiles,
      scopePreviewByProfile,
    }

    // 3. Human consent (WS4 seam).
    //
    //    The REAL (interactive, WS4 S3) `ConsentFn` renders the consent HTML
    //    directly onto `res` (ending THIS `GET /authorize` response) and
    //    returns without an inline decision — the human decides LATER, via a
    //    separate `POST /authorize/decision` request that `consent-http.ts`
    //    handles on ITS OWN `res` (calling `finalizeApprovedAuthorization`
    //    below directly). `res.headersSent` is how we detect that case: if
    //    the consent implementation already fully answered this response,
    //    there is nothing left for `authorize()` to do. A fake/test
    //    `ConsentFn` never touches `res`, so `res.headersSent` stays `false`
    //    and the tail below runs exactly as it did before this change.
    const decision = await this.deps.requestConsent(consentReq, { res, client, params, assessment })
    if (res.headersSent) {
      return
    }
    if (!decision.approved) {
      throw new AccessDeniedError('Consent was not granted.')
    }

    // 4-7: eligibility re-check, set-once bind, scope mint, persist grant +
    // auth code, build the redirect — extracted to `finalizeApprovedAuthorization`
    // so the real interactive flow's decision route can share the exact same
    // logic (see that function's doc comment).
    const redirect = await finalizeApprovedAuthorization(
      { store: this.deps.store, trust: this.deps.trust, policy: this.deps.policy, now: this.deps.now },
      client.client_id,
      assessment,
      params,
      decision.profileId,
      // The grant is DPoP-bound iff the client declared a DPoP key at
      // `/authorize` — which is exactly what drove `maxScopeSensitivity: 'high'`.
      // Deriving it from the assessment (not `decision.dpopBound`) means the
      // authoritative binding can never diverge from the scope ceiling, and is
      // identical to the derivation `consent-http.ts` uses on its own path.
      assessment.maxScopeSensitivity === 'high'
    )
    res.redirect(302, redirect.href)
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    // Non-consuming peek — `consumeAuthCode` (in exchangeAuthorizationCode)
    // stays the single-use gate. A fabricated code has no stored challenge.
    const stored = this.deps.store.getAuthCode(authorizationCode)
    if (stored === undefined) {
      throw new InvalidGrantError('Authorization code is invalid.')
    }
    return stored.codeChallenge
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE already verified by the SDK (skipLocalPkceValidation unset)
    redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    // Single-use + expiry gate: consumeAuthCode returns the code exactly once.
    const consumed = this.deps.store.consumeAuthCode(authorizationCode)
    if (consumed === undefined) {
      throw new InvalidGrantError('Authorization code is invalid, expired, or already used.')
    }
    const grant = this.deps.store.getGrant(consumed.grantId)
    if (grant === undefined || grant.revokedAt !== undefined) {
      throw new InvalidGrantError('Grant not found or revoked.')
    }
    if (grant.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was not issued to this client.')
    }
    // RFC 6749 §4.1.3: redirect_uri must match the one used at /authorize.
    if (redirectUri !== undefined && redirectUri !== consumed.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.')
    }

    // DPoP binding (M3). The proof presented at THIS `/token` request was
    // validated by `dpop.ts`'s `dpopTokenBinding` middleware and reaches us via
    // the async-context side channel (this method gets no request object).
    //  - A `dpopBound` grant (declared a DPoP key at `/authorize`, hence its
    //    high-sensitivity scope) MUST present a proof here, or the token would
    //    silently downgrade to bearer while carrying an action-bearing scope.
    //  - A bearer grant with a proof present still opts in to binding (DPoP is
    //    per-token optional); a bearer grant with no proof stays plain Bearer.
    const proof = getBoundDpopProof()
    if (grant.dpopBound && proof === undefined) {
      throw new InvalidGrantError('This authorization is DPoP-bound; a DPoP proof is required at the token endpoint.')
    }
    // Scope was minted server-side at consent from the grant's profile — reuse
    // it; never read a client-supplied scope (WS2 §6 invariant).
    return this.issueTokens(grant.grantId, grant.scopes, proof?.jkt)
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[], // IGNORED — a client cannot re-scope on refresh (WS2 §4.5)
    _resource?: URL
  ): Promise<OAuthTokens> {
    const stored = this.deps.store.getToken(refreshToken) // hashes + filters expired
    if (stored === undefined || stored.kind !== 'refresh') {
      throw new InvalidGrantError('Refresh token is invalid or expired.')
    }
    const grant = this.deps.store.getGrant(stored.grantId)
    if (grant === undefined || grant.revokedAt !== undefined) {
      throw new InvalidGrantError('Grant not found or revoked.')
    }
    if (grant.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was not issued to this client.')
    }

    // DPoP binding is PRESERVED across rotation (M3). If the presented refresh
    // token was DPoP-bound, the caller must prove possession of the SAME key
    // again — a leaked refresh token is useless without the private key — and
    // the rotated pair stays bound to that same thumbprint. A bearer refresh
    // token stays bearer (any presented proof is ignored on that path, so the
    // plain-Bearer flow is byte-identical to before M3).
    const proof = getBoundDpopProof()
    if (stored.jkt !== undefined) {
      if (proof === undefined) {
        throw new InvalidGrantError('This refresh token is DPoP-bound; a DPoP proof is required at the token endpoint.')
      }
      if (proof.jkt !== stored.jkt) {
        throw new InvalidGrantError('DPoP proof key does not match the DPoP-bound refresh token.')
      }
    }
    const jkt = stored.jkt

    // Re-mint against the grant's ORIGINAL stored scope/assessment (WS7 §4:
    // never silently re-assess mid-grant). Rotate the refresh token so a
    // leaked one is single-use.
    const now = this.now()
    const createdAt = new Date(now).toISOString()
    const accessToken = mintOpaqueToken()
    const newRefreshToken = mintOpaqueToken()

    this.deps.store.putToken({
      tokenHash: this.hash(accessToken),
      kind: 'access',
      grantId: grant.grantId,
      jkt, // preserve the binding (undefined for a bearer refresh)
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      createdAt,
    })
    this.deps.store.rotateRefresh(refreshToken, {
      tokenHash: this.hash(newRefreshToken),
      kind: 'refresh',
      grantId: grant.grantId,
      jkt,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      createdAt,
      rotatedFrom: stored.tokenHash,
    })

    return this.tokensResponse(accessToken, newRefreshToken, grant.scopes, jkt, now + ACCESS_TOKEN_TTL_MS, now)
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.deps.store.getToken(token) // hashes + filters expired
    if (stored === undefined || stored.kind !== 'access') {
      throw new InvalidTokenError('Access token is invalid or expired.')
    }
    const grant = this.deps.store.getGrant(stored.grantId)
    if (grant === undefined || grant.revokedAt !== undefined) {
      throw new InvalidTokenError('Access token has been revoked.')
    }

    // "Last used" for WS4's connected-clients list.
    this.deps.store.touchGrant(grant.grantId, new Date(this.now()).toISOString())

    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      // The SDK bearer middleware compares expiresAt in SECONDS; the store keeps
      // it in ms.
      expiresAt: Math.floor(stored.expiresAt / 1000),
      extra: {
        // The seam WS3's `resolvePrincipal` reads — this is what makes
        // per-request identity real (acceptance #1/#4).
        profileId: grant.profileId,
        // DPoP thumbprint seam (undefined in M2's bearer baseline).
        ...(stored.jkt !== undefined ? { jkt: stored.jkt } : {}),
      },
    }
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const stored = this.deps.store.getToken(request.token)
    // RFC 7009: an invalid/unknown token is a silent success.
    if (stored === undefined) return
    const grant = this.deps.store.getGrant(stored.grantId)
    // Only revoke a token that belongs to a grant owned by the requesting
    // client — otherwise silently do nothing (RFC 7009).
    if (grant === undefined || grant.clientId !== client.client_id) return
    // Deleting the token makes the live `verifyAccessToken` lookup reject the
    // very next request (acceptance #3 immediate-rejection mechanism).
    this.deps.store.deleteToken(request.token)
  }

  /**
   * Issues + persists an opaque access/refresh pair for a grant, returning the
   * SDK `OAuthTokens`. `jkt` is the DPoP thumbprint to bind both tokens to
   * (`undefined` for a plain-Bearer issuance).
   */
  private issueTokens(grantId: string, scopes: string[], jkt: string | undefined): OAuthTokens {
    const now = this.now()
    const createdAt = new Date(now).toISOString()
    const accessToken = mintOpaqueToken()
    const refreshToken = mintOpaqueToken()
    const accessExpiresAt = now + ACCESS_TOKEN_TTL_MS

    this.deps.store.putToken({
      tokenHash: this.hash(accessToken),
      kind: 'access',
      grantId,
      jkt,
      expiresAt: accessExpiresAt,
      createdAt,
    })
    this.deps.store.putToken({
      tokenHash: this.hash(refreshToken),
      kind: 'refresh',
      grantId,
      jkt,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      createdAt,
    })

    return this.tokensResponse(accessToken, refreshToken, scopes, jkt, accessExpiresAt, now)
  }

  private tokensResponse(
    accessToken: string,
    refreshToken: string,
    scopes: string[],
    jkt: string | undefined,
    accessExpiresAt: number,
    now: number
  ): OAuthTokens {
    return {
      access_token: accessToken,
      // `DPoP` iff the tokens are sender-constrained to a proof key; plain
      // `Bearer` otherwise (parent §10 — DPoP is never mandated server-wide).
      token_type: jkt !== undefined ? 'DPoP' : 'Bearer',
      expires_in: Math.floor((accessExpiresAt - now) / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    }
  }
}

/**
 * Reads the RFC 9449 §10 `dpop_jkt` authorization request parameter off the
 * live request behind `res` (`res.req`, Express's public request back-reference).
 * Returns the thumbprint string, or `undefined` when absent, non-string
 * (repeated query param → array), empty, or when `res` has no `req` (a unit
 * test's fake `Response`). This never trusts it as identity — it is only a hint
 * that the client intends to use DPoP, which the trust provider turns into a
 * scope-sensitivity ceiling; possession is proven for real at `/token`.
 */
function readDpopJktParam(res: Response): string | undefined {
  const req = (res as unknown as { req?: { query?: Record<string, unknown> } }).req
  const raw = req?.query?.dpop_jkt
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}
