/**
 * `CladOAuthProvider` — Clad's `OAuthServerProvider` implementation (D5.3
 * WS2 S2-S3, `.claude/plans/d5.3/WS2-oauth-resource-server.md` §3).
 *
 * SCOPE (S2-S3 ONLY — Wave 4 fills in the rest):
 *  - `clientsStore` is REAL: `getClient`/`registerClient` are backed by
 *    `@clad/core`'s `SqliteGrantStore` (WS5), so RFC 7591 Dynamic Client
 *    Registration round-trips against a real, encrypted-at-rest client
 *    record — `mcpAuthRouter`'s `/register` handler works unattended.
 *  - Every OTHER `OAuthServerProvider` method (`authorize`,
 *    `challengeForAuthorizationCode`, `exchangeAuthorizationCode`,
 *    `exchangeRefreshToken`, `verifyAccessToken`, `revokeToken`) is a clear
 *    seam that throws {@link OAuthFlowNotImplementedError} — a fixed,
 *    secret-free message. Wave 4 (WS2 §7 S4-S6: authorize + consent seam,
 *    token exchange + verify + scope minting, revoke + refresh) implements
 *    these for real. Mounting `mcpAuthRouter` still works today: the SDK
 *    only calls these methods when a request actually reaches `/authorize`,
 *    `/token`, or `/revoke` — S2-S3 only exercises `/register` and the two
 *    `/.well-known/*` metadata documents.
 */

import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Response } from 'express'
import type { GrantStore, StoredClient } from '@clad/core'

/**
 * Thrown by every `CladOAuthProvider` flow method that isn't implemented yet
 * (S2-S3: only `clientsStore` is real). A FIXED, secret-free message — mirrors
 * `UnauthenticatedError`/`TokenStoreKeyError`'s discipline
 * (`server-core.ts` / `@clad/core`'s `token-store-errors.ts`). `flow` is one
 * of a small, compile-time-controlled set of literal method names (never
 * request- or secret-derived), so interpolating it can't leak anything, but
 * the surrounding text never varies between calls.
 */
export class OAuthFlowNotImplementedError extends Error {
  readonly code = 'OAUTH_FLOW_NOT_IMPLEMENTED' as const

  constructor(flow: string) {
    super(
      `OAuth flow "${flow}" is not implemented yet (D5.3 Wave 4). ` +
        'Dynamic client registration and metadata discovery are the only live ' +
        'OAuth surfaces today. No secret material is included in this error.'
    )
    this.name = 'OAuthFlowNotImplementedError'
  }
}

export interface CladOAuthProviderDeps {
  /** WS5's grant store — registered clients, consented grants, auth codes, tokens. */
  store: GrantStore
}

/**
 * Maps the SDK's `token_endpoint_auth_method` (a free-form string per RFC
 * 7591 — `OAuthClientMetadataSchema.token_endpoint_auth_method` is
 * `z.ZodOptional<z.ZodString>`, not an enum) onto the restricted set WS2 §10
 * supports (`'none' | 'client_secret_post'` — never `client_secret_basic` or
 * anything else). Rather than trust the client's self-reported string
 * (which could name an unsupported method), the actual discriminator is
 * whether the SDK generated a secret for this registration
 * (`clientRegistrationHandler` in the SDK's `register.js`:
 * `isPublicClient = token_endpoint_auth_method === 'none'`, and secret
 * generation is skipped only in that case) — so a present `client_secret`
 * always means `'client_secret_post'` here, and an absent one always means
 * `'none'`.
 */
function resolveAuthMethod(clientSecret: string | undefined): StoredClient['tokenEndpointAuthMethod'] {
  return clientSecret ? 'client_secret_post' : 'none'
}

/**
 * Maps a `StoredClient` (WS5) back onto the SDK's `OAuthClientInformationFull`
 * shape for a `getClient`/`registerClient` response. `passthrough` carries any
 * extra DCR request metadata (grant_types, response_types, contacts, etc.)
 * the store doesn't persist but RFC 7591 expects echoed back on registration;
 * omitted on a plain `getClient` read, where no such metadata is available.
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

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => {
        const stored = this.deps.store.getClient(clientId)
        if (!stored) return undefined
        // The store never returns a client secret on read — `getClient`'s
        // own doc comment: "the secret is write-only from this store's
        // perspective." Comparing a `client_secret_post` client's secret at
        // `/token` needs its own verification seam and is Wave 4 scope, not
        // S2-S3's DCR round-trip.
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
        // Echo the raw secret the SDK generated (`register.js`) back to the
        // caller — the store only ever persists it AES-256-GCM encrypted and
        // never returns it (see `getClient` above), so this in-memory value
        // from the request itself is the only place it's still available to
        // include in the RFC 7591 response. `client` is also spread in as
        // `passthrough` so request-only metadata (grant_types,
        // response_types, contacts, etc.) round-trips even though the store
        // doesn't persist it.
        return toClientInformationFull(stored, client.client_secret, client)
      },
    }
  }

  async authorize(_client: OAuthClientInformationFull, _params: AuthorizationParams, _res: Response): Promise<void> {
    throw new OAuthFlowNotImplementedError('authorize')
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    _authorizationCode: string
  ): Promise<string> {
    throw new OAuthFlowNotImplementedError('challengeForAuthorizationCode')
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    _authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    throw new OAuthFlowNotImplementedError('exchangeAuthorizationCode')
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    throw new OAuthFlowNotImplementedError('exchangeRefreshToken')
  }

  async verifyAccessToken(_token: string): Promise<AuthInfo> {
    throw new OAuthFlowNotImplementedError('verifyAccessToken')
  }

  async revokeToken(_client: OAuthClientInformationFull, _request: OAuthTokenRevocationRequest): Promise<void> {
    throw new OAuthFlowNotImplementedError('revokeToken')
  }
}
