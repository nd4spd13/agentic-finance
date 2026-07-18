# WS2 — OAuth 2.1 authorization + resource server (detailed design)

Parent: [`../D5.3-authenticated-agent-identity-plan.md`](../D5.3-authenticated-agent-identity-plan.md) §3 WS2, §7.2, §10.
Status: **design / implementation-ready.** Highest design-uncertainty workstream — plan this before WS3/WS5/WS4/WS7.

Grounding (verified against the installed SDK): `@modelcontextprotocol/sdk@1.29.0` (pnpm-resolved: `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.3.6/...`). Exact export names/shapes recorded in §2 are read from that install's `dist/esm/server/auth/*.d.ts` — not assumed.

---

## 1. Goal & acceptance advanced

Make Clad a **local OAuth 2.1 Authorization Server *and* Resource Server** so an MCP client obtains an access token that Clad itself minted, bound to a human-approved agent profile, with the granted scope derived server-side from `policy.agents[profile]`.

D5.3 acceptance advanced (from parent §1):
- **#1 (no id-spoofing):** identity is the profile bound to the grant at consent time, never a client-asserted claim — this WS produces the token; WS3 enforces it.
- **#2 (scope binds to an authenticated key):** scope is minted server-side and stored on the grant; DPoP binding (M3) ties it to a client key thumbprint. This WS lays the bearer-baseline and the `cnf.jkt` seam.
- **#4 (policy keys off verified identity):** the token's resolved profile becomes `ToolContext.agentId` (WS3), replacing `CLAD_AGENT_ID`.

Milestone mapping (parent §4): this WS is the bulk of **M2** (real OAuth, bearer only), with the DPoP hooks stubbed for **M3**.

---

## 2. What the SDK provides vs. what we hand-roll

Read from `dist/esm/server/auth/` in the installed 1.29.0:

| Need | SDK gives us | Exact export | Hand-roll? |
| --- | --- | --- | --- |
| AS + PRM metadata, `/register`, `/authorize`, `/token`, `/revoke` mounted as one router | `mcpAuthRouter(options: AuthRouterOptions): RequestHandler` | `server/auth/router.js` | No — mount it. **Express-only.** |
| Provider contract the router calls into | `interface OAuthServerProvider` | `server/auth/provider.js` | **Yes — we implement it** (`CladOAuthProvider`). |
| Registered-clients store contract | `interface OAuthRegisteredClientsStore` (`getClient`, optional `registerClient`) | `server/auth/clients.js` | **Yes — back it with WS5's grant store.** |
| Bearer validation middleware (sets `req.auth`) | `requireBearerAuth({ verifier, requiredScopes?, resourceMetadataUrl? }): RequestHandler` | `server/auth/middleware/bearerAuth.js` | No — mount it in front of `/mcp`. |
| The `req.auth` payload type | `interface AuthInfo { token; clientId; scopes[]; expiresAt?; resource?; extra? }` | `server/auth/types.js` | No — **`extra` is our profile+jkt seam.** |
| Standalone metadata router (RS-only, external AS) | `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl` | `server/auth/router.js` | **Not used** — we are AS+RS, not RS-only. |
| Metadata document schemas (RFC 8414 / RFC 9728) | `OAuthMetadataSchema`, `OAuthProtectedResourceMetadataSchema` (`z.core.$loose`) | `shared/auth.js` | No — validate our docs against them in tests. |
| Token/refresh/client shapes | `OAuthTokens`, `OAuthClientInformationFull`, `OAuthTokenRevocationRequest` | `shared/auth.js` | No — implement to these types. |

**What the SDK does NOT provide, and we must hand-roll:**
1. **The consent UI.** `authorizationHandler` calls `provider.authorize(client, params, res)` and expects *us* to eventually `res.redirect(redirectUri?code=…&state=…)`. The human approval that binds client→profile lives entirely inside our `authorize()` (that's WS4). The SDK does PKCE plumbing and redirect-URI validation (`redirectUriMatches`, `server/auth/handlers/authorize.d.ts:22`) but has no notion of "which profile".
2. **Scope minting.** The SDK never derives scope from anything — it just carries whatever scopes the provider puts on the issued `OAuthTokens`. We mint from `policy.agents[profile]` (§6).
3. **DPoP (RFC 9449).** Confirmed absent: `OAuthServerProvider.verifyAccessToken(token)` takes **only the token string** (`provider.d.ts`) — it has no access to the request, the `DPoP` header, htu/htm, or a replay cache. So sender-constraint cannot live in the SDK verifier. **All DPoP proof validation is hand-rolled middleware** (§8, M3). The metadata schema *does* carry `dpop_signing_alg_values_supported` / `dpop_bound_access_tokens_required` (`OAuthProtectedResourceMetadataSchema`, `shared/auth.d.ts:9-27`), so we can advertise DPoP without the SDK enforcing it — exactly the "advertise-optional, enforce-ourselves" posture parent §10 wants.
4. **Opaque-token storage & lookup.** `verifyAccessToken` is *our* store lookup (WS5), not a JWT verify.

### 2.1 The Express dependency decision (load-bearing)

Every SDK auth handler is an **Express `RequestHandler`** and `mcpAuthRouter` "MUST be installed at the application root" (`router.d.ts` doc). The just-landed transport (`packages/mcp-server/src/http-transport.ts:37`) is raw `node:http`. Two options:

- **(A, chosen) Adopt Express in the mcp-server HTTP path.** Add `express@^5` (the SDK's own peer — `sdk/package.json:111` pins `express@^5.2.1`; `express@5.2.1` is already in the pnpm store) as a direct dep of `@clad/mcp-server`. Rebuild `startHttpServer` around an Express app: mount `mcpAuthRouter` at root, mount `requireBearerAuth` + the DPoP middleware on `POST/GET/DELETE /mcp`, and keep the existing session-map logic inside the `/mcp` handler. `StreamableHTTPServerTransport.handleRequest(req, res, body)` accepts Express `req`/`res` unchanged (they are `IncomingMessage`/`ServerResponse` supersets) and reads `req.auth` (`streamableHttp.js:131`), so the transport itself is untouched.
- (B, rejected) Keep `node:http` and re-implement the four RFCs by hand. Rejected: re-deriving RFC 7591/8414/9728/PKCE plumbing the SDK already ships is exactly the "backfill only what's missing" anti-goal, and drifts from Claude/mcp-remote's tested expectations.

**Preserve from the current node:http server** when porting to Express (these are security-load-bearing, `http-transport.ts`):
- `isLoopbackHost` DNS-rebinding guard (`:87`) → an Express middleware that runs **first**, `403` on non-loopback `Host`.
- `127.0.0.1`-only bind (`:138`), never `0.0.0.0`.
- 4 MiB body cap (`:113`) → `express.json({ limit: '4mb' })`, but **scoped to the auth routes only** — the `/mcp` transport must still receive the raw body / stream it manages itself (it re-reads via `handleRequest`), so do **not** globally `express.json()` ahead of `/mcp`. Mirror the current "parse-once, pass `body` through" handling (`:211-241`).
- `writeRedactedStderr` on every error path (`:144`).

---

## 3. File-level changes

### New files (all under `packages/mcp-server/src/oauth/`)

```
packages/mcp-server/src/oauth/
  provider.ts          # CladOAuthProvider implements OAuthServerProvider
  metadata.ts          # buildAsMetadata() / buildProtectedResourceMetadata()
  scope-minter.ts      # mintScopesForProfile(policy, profileId) — the ONLY scope source
  consent.ts           # WS4 seam: requestConsent(client, params) -> ConsentDecision
  dpop.ts              # M3: parseAndVerifyDpopProof(), jktThumbprint()  (stub in M2)
  errors.ts            # OAuth error → RFC 6749 §5.2 JSON shaping (redacted)
```

`CladOAuthProvider` (provider.ts) — the core hand-rolled object:

```ts
import type {
  OAuthServerProvider, AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
  OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { GrantStore } from '@clad/core'          // WS5
import type { PolicyConfig } from '@clad/core'

export interface CladOAuthProviderDeps {
  store: GrantStore                 // WS5: clients, grants, tokens, jkt thumbprints
  policy: PolicyConfig              // scope source (never the client)
  requestConsent: ConsentFn         // WS4: returns approved profile or rejection
  now?: () => number                // injectable clock for tests
}

export class CladOAuthProvider implements OAuthServerProvider {
  constructor(private readonly deps: CladOAuthProviderDeps) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.deps.store.getClient(id),
      // RFC 7591 DCR: the SDK generates client_id/secret; we persist + return.
      registerClient: (client) => this.deps.store.registerClient(client),
    }
  }

  // /authorize: PKCE S256 already validated by the SDK handler shape; we run
  // the WS4 consent step, bind client->profile on a pending grant, then redirect.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res): Promise<void> { … }

  async challengeForAuthorizationCode(client, authorizationCode): Promise<string> { … } // returns stored S256 challenge

  // /token (auth-code): mint scope server-side from the grant's profile; issue opaque token.
  async exchangeAuthorizationCode(client, code, codeVerifier?, redirectUri?, resource?): Promise<OAuthTokens> { … }

  async exchangeRefreshToken(client, refreshToken, scopes?, resource?): Promise<OAuthTokens> { … } // IGNORES `scopes` arg — re-mints from profile

  async verifyAccessToken(token: string): Promise<AuthInfo> { … } // opaque lookup; throws on unknown/expired/revoked

  async revokeToken(client, request: OAuthTokenRevocationRequest): Promise<void> { … } // delete → immediate rejection (WS4 revoke)

  // PKCE is validated locally (we ARE the AS). Do NOT set skipLocalPkceValidation.
}
```

`scope-minter.ts` — the single server-side scope authority:

```ts
/** The ONLY function allowed to produce a scope set. Never reads a client-supplied scope. */
export function mintScopesForProfile(policy: PolicyConfig, profileId: string): string[]
export function scopeSensitivity(scope: string): 'low' | 'high'   // gates DPoP (§8, parent §10)
```

`consent.ts` — the WS4 boundary (kept an interface here so WS2 is testable without Electron):

```ts
export interface ConsentRequest {
  clientId: string
  clientName?: string
  requestedProfileHint?: string        // client MAY hint; we never trust it as identity
  availableProfiles: string[]          // from policy.agents keys
  scopePreviewByProfile: Record<string, string[]>
}
export type ConsentDecision =
  | { approved: true; profileId: string; dpopBound: boolean }
  | { approved: false; reason: 'denied' | 'no-eligible-profile' }
export type ConsentFn = (req: ConsentRequest) => Promise<ConsentDecision>
```

### New files under `packages/mcp-server/src/`

- `http-transport.ts` — **modified** (see §3.1), or a sibling `http-app.ts` that builds the Express app and is consumed by `startHttpServer`. Prefer extracting `buildHttpApp(resources, oauth): express.Express` into `http-app.ts` and keeping `startHttpServer` as the listen/close wrapper, so the app is unit-testable with `supertest`-style in-process requests.

### Modified files

- `packages/mcp-server/package.json` — add `express@^5.2.1` (+ `@types/express` dev). Optionally `express-rate-limit` (the SDK handlers accept a `rateLimit` option and default it on; for a loopback single-user server we can pass `rateLimit: false` on `/authorize`+`/token`+`/register` to avoid the extra dep, or keep the SDK default — decide in §9 open questions).
- `packages/mcp-server/src/http-transport.ts` — swap `node:http` server for the Express app; keep `isLoopbackHost`, `resolveMcpHttpPort`, `DEFAULT_MCP_HTTP_PORT`, `LOOPBACK_HOST`, `MCP_HTTP_PATH`, `HttpServerHandle` exports **unchanged** (desktop's `mcp-loopback.ts:29` mirrors these constants and must keep matching).
- `packages/mcp-server/src/server-core.ts` — `ServerResources` gains an optional `oauth?: CladOAuthProvider` (undefined on the stdio/dummy path). `loadServerResources()` constructs it only when auth is enabled (a `CLAD_MCP_AUTH=oauth` flag, default off during M1/M2 beta — parent §4 "behind a dev/beta flag").
- `packages/mcp-server/src/server.ts` — no change (still selects transport by `CLAD_MCP_TRANSPORT`).

### 3.1 How the Express app mounts (integration shape)

```ts
export function buildHttpApp(resources: ServerResources): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(loopbackHostGuard)                       // isLoopbackHost -> 403 (was http-transport.ts:184)

  if (resources.oauth) {
    // RFC 9728 + 8414 + 7591 + authorize/token/revoke, all at root.
    app.use(mcpAuthRouter({
      provider: resources.oauth,
      issuerUrl: new URL(`http://127.0.0.1:${port}`),
      resourceServerUrl: new URL(`http://127.0.0.1:${port}/mcp`),
      resourceName: 'Clad',
      scopesSupported: allKnownScopes(resources.policy),
    }))
    // Bearer (+ DPoP in M3) in FRONT of the MCP endpoint.
    app.use(MCP_HTTP_PATH, requireBearerAuth({
      verifier: resources.oauth,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`http://127.0.0.1:${port}/mcp`)),
    }))
    app.use(MCP_HTTP_PATH, dpopEnforcement(resources.oauth))   // M3, no-op stub in M2
  }

  app.all(MCP_HTTP_PATH, mcpEndpointHandler(resources))         // existing session-map logic, reads req.auth
  return app
}
```

The `mcpEndpointHandler` is the **only** behavioural change vs. today's `handleHttpRequest` (`http-transport.ts:177`): the session-map, `isInitializeRequest`, `StreamableHTTPServerTransport` construction, and `transport.handleRequest(req, res, body)` all stay. `req.auth` is now populated by `requireBearerAuth` and threads to `RequestHandlerExtra.authInfo` — that is the seam WS3 consumes.

---

## 4. Endpoint-by-endpoint design

### 4.1 `GET /.well-known/oauth-protected-resource` (RFC 9728) — provided by `mcpAuthRouter`
Advertises: `resource` = `http://127.0.0.1:<port>/mcp`, `authorization_servers` = `[issuerUrl]`, `bearer_methods_supported: ["header"]`, `scopes_supported`, and — for the DPoP-optional posture — `dpop_signing_alg_values_supported: ["ES256"]` with `dpop_bound_access_tokens_required: false` (never `true` server-wide; parent §10). Validate the emitted doc against `OAuthProtectedResourceMetadataSchema` in tests.

### 4.2 `GET /.well-known/oauth-authorization-server` (RFC 8414) — provided by `mcpAuthRouter`
`issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `code_challenge_methods_supported: ["S256"]` (S256 only — never `plain`), `token_endpoint_auth_methods_supported: ["none","client_secret_post"]`. Add `dpop_signing_alg_values_supported: ["ES256"]` (schema is `z.core.$loose`, extra keys pass).

### 4.3 `POST /register` (RFC 7591 DCR) — SDK handler → our `clientsStore.registerClient`
The SDK generates `client_id` (+ secret if confidential); we persist the full record to WS5 and return it. A freshly registered client is **not yet bound to any profile** — binding happens at consent (`/authorize`). Store `client_id_issued_at`; honour `client_secret_expires_at` (the SDK middleware auto-rejects expired secrets — `clients.d.ts` note). mcp-remote and Claude both DCR, so this must work unattended.

### 4.4 `GET /authorize` (+ PKCE S256) — SDK handler → our `provider.authorize()`
1. SDK validates `redirect_uri` against the registered client (`redirectUriMatches`) and carries `code_challenge`/`code_challenge_method`/`state`.
2. Our `authorize()` builds a `ConsentRequest` (available profiles = `Object.keys(policy.agents)`, scope preview per profile from `mintScopesForProfile`) and calls `deps.requestConsent` (WS4 renders the human screen).
3. On approve: create a **pending grant** in WS5 keyed by a fresh `authorization_code`, storing `{ clientId, profileId, codeChallenge, redirectUri, scopes: mintScopesForProfile(...), dpopBound, expiresAt: now+60s }`. Then `res.redirect(302, redirectUri + ?code=…&state=…)`.
4. On deny / no eligible profile: `res.redirect(redirectUri + ?error=access_denied&state=…)`.

**PKCE:** S256 only. We validate locally (`skipLocalPkceValidation` stays false/unset — we are the real AS, not a proxy). `challengeForAuthorizationCode()` returns the stored challenge so the SDK's token handler verifies `code_verifier`.

### 4.5 `POST /token` (auth-code + PKCE exchange) — SDK handler → `provider.exchangeAuthorizationCode()`
1. Look up the pending grant by `code`; reject if missing/expired/already-consumed (**single-use** — delete on redeem to prevent replay).
2. The SDK verifies the PKCE `code_verifier` against the challenge from `challengeForAuthorizationCode`.
3. **Mint scope server-side from the grant's `profileId`** via `mintScopesForProfile` — ignore anything client-supplied. (The grant already stored the minted scopes at authorize time; re-derive or reuse, but never read a request scope.)
4. Issue an **opaque** access token (`randomBytes(32).toString('base64url')`) and refresh token; persist `{ token, clientId, profileId, scopes, expiresAt, cnf?: { jkt } }` to WS5. Return `OAuthTokens` `{ access_token, token_type: dpopBound ? 'DPoP' : 'Bearer', expires_in, refresh_token, scope }`.

**Opaque, not JWT — justification (parent §2 WS2, restated):** single-process owner ⇒ (a) **instant revocation** is a store delete, no revocation-list/JWT-blacklist race; (b) **no signing-key custody or rotation** — one less secret in WS5; (c) `verifyAccessToken` is already a store round-trip we need for scope/binding anyway, so JWT buys nothing but signing complexity. Revisit only if a stateless multi-node story ever appears (there is none — the server is the desktop app's supervised child).

### 4.6 `POST /revoke` (RFC 7009) — SDK handler → `provider.revokeToken()`
Delete the token (and optionally its whole grant) from WS5. Because `verifyAccessToken` is a live lookup, deletion ⇒ the very next request 401s. This is the mechanism behind WS4's "revoke → immediate token rejection" and acceptance-relevant replay defence.

---

## 5. Token binding (DPoP) posture — hooks now, enforcement in M3

Per parent §10: **bearer-baseline, DPoP-optional, bound per-token, gated by scope, never mandated server-wide.**

- **M2 (this WS's default):** all tokens are plain Bearer. `dpop.ts` exists but `dpopEnforcement()` is a pass-through. `cnf.jkt` is `undefined` on issued tokens. Acceptance #1 and #4 are met; #2/#3 are explicitly deferred (parent §10 closing paragraph — not achievable with today's bearer-only ecosystem).
- **M3:** see §8. The seam is already in place: `AuthInfo.extra.jkt` carried on the token, `scopeSensitivity()` deciding which profiles *require* a bound token, and metadata advertising DPoP as optional.

---

## 6. Scope model (the server-side contract)

Scopes are an **internal, server-minted vocabulary** derived from `policy.agents[profile].permissions`, e.g.:

| Permission signal (`evaluator.ts` / `policy.types.ts`) | Minted scope |
| --- | --- |
| `accounts.visible` non-empty / `accounts.balance` | `clad:accounts.read` |
| `transactions.read` | `clad:transactions.read` (+ `:lookback=<days>` note stored on grant, not scope) |
| `spending.*` present (action-bearing) | `clad:actions.request` — **high sensitivity** |
| `audit` | `clad:audit.read` |

`mintScopesForProfile` is the single source (§3). Two invariants, both unit-tested (parent §6):
1. **Never** reads `params.scopes` / request `scope` — the client cannot widen its grant.
2. Deterministic from `(policy, profileId)` — the same profile always mints the same scope set, so a re-consent or refresh is stable.

Scope is *advisory to the resource layer* today (the real allow/deny still runs through `evaluator.ts` keyed on `agentId` — WS3). Scope's job here is (a) DPoP gating (§8) and (b) honest metadata/consent display. It becomes load-bearing for field-shaping once **D5.2** lands (parent §5: "without D5.2 a verified identity still returns unshaped payloads").

---

## 7. Internal sequencing (sub-steps)

1. **S1 — Express port (no auth yet).** Extract `buildHttpApp`; move the loopback guard + `/mcp` handler onto Express; prove `http-transport.test.ts` still green with the real SDK HTTP client. No behaviour change. *(De-risks §2.1 in isolation.)*
2. **S2 — Metadata only.** Add `mcpAuthRouter` with a **stub provider** (empty clientsStore, `verifyAccessToken` throws). Assert `/.well-known/*` docs validate against the SDK schemas. Bearer middleware not yet in front of `/mcp`.
3. **S3 — DCR + clientsStore.** Wire `registerClient`/`getClient` to WS5 (depends on WS5's `GrantStore` existing — see §Dependencies). `/register` round-trips.
4. **S4 — authorize + consent seam.** Implement `authorize()` against a **fake `ConsentFn`** (auto-approve a fixed profile) so WS2 is testable before WS4's UI exists. Pending-grant persistence in WS5.
5. **S5 — token + verify + scope minting.** `exchangeAuthorizationCode`, opaque token issue, `verifyAccessToken` lookup, `mintScopesForProfile`. Mount `requireBearerAuth` in front of `/mcp`.
6. **S6 — revoke + refresh.** `revokeToken`, `exchangeRefreshToken` (re-mints scope). Immediate-rejection test.
7. **S7 — DPoP stubs.** Land `dpop.ts` interfaces + pass-through `dpopEnforcement`; advertise DPoP-optional metadata. (Enforcement is M3/§8.)

### Dependencies on other workstreams
- **WS5 (grant store) is a hard predecessor** for S3–S6 — `CladOAuthProvider` is a thin policy/flow layer over it. Plan/land WS5's interface first (it is the next file after this one, per the task's priority order).
- **WS4 (consent UI)** is consumed via the `ConsentFn` seam (§3, `consent.ts`). WS2 lands with a fake `ConsentFn`; WS4 supplies the real Electron-backed one. No blocking either direction after the interface is fixed.
- **WS3 (enforcement)** consumes `req.auth`/`authInfo.extra.profileId` this WS produces. WS2 can land and be tested (authorize→token→`verifyAccessToken`) without WS3; WS3 is what makes the token actually change `agentId`.
- **WS7 (`TrustProvider`)**: `mintScopesForProfile` + the identity-resolution in `verifyAccessToken` are the two call sites WS7 will route through its interface. Keep them as standalone functions so WS7 can wrap them without touching the provider.

---

## 8. M3 — DPoP enforcement design (hand-rolled, since the SDK verifier can't see the request)

`dpop.ts`:
```ts
export interface DpopProof { jkt: string; htu: string; htm: string; iat: number; jti: string }
export function parseAndVerifyDpopProof(
  dpopHeader: string, method: string, url: string, now: number,
  jtiReplayCache: JtiCache,
): DpopProof                       // throws on bad sig / htu/htm mismatch / stale iat / replayed jti
export function jktThumbprint(publicJwk: JsonWebKey): string   // RFC 7638 SHA-256 thumbprint
```

`dpopEnforcement(oauth)` middleware, running **after** `requireBearerAuth` populated `req.auth`:
1. If `req.auth.extra?.jkt` is set (token is DPoP-bound) → a valid `DPoP` proof is **required**; its `jkt` must equal `req.auth.extra.jkt`. Missing/invalid ⇒ `401 WWW-Authenticate: DPoP error="invalid_token"`. **This is the downgrade-safe rule** (parent §10): a bound token can never be replayed as plain Bearer.
2. If `req.auth.extra?.jkt` is unset (plain Bearer token) but the requested scope is **high-sensitivity** (`scopeSensitivity(scope) === 'high'` for any scope on the token) ⇒ reject. High-privilege scopes are simply never *minted* onto a bearer-only grant (the gate is enforced at **consent/token time** in §4.4–4.5, not per request), so this is defence-in-depth.
3. `jti` replay cache is in-memory, TTL = proof `iat` window (e.g. 60s) — sufficient for a single-process loopback server.

At `/token`, DPoP-bound issuance keys off the `DPoP` header on the token request: if present and valid, store `cnf.jkt` on the token and set `token_type: 'DPoP'`.

**M3 residual (parent §7.1):** confirm whether the pinned `mcp-remote` can present a DPoP proof at all. If not, high-sensitivity scopes are simply unreachable over the local loopback path until it can — which only limits *what a locally-connected profile may do*, never whether clients can connect. No server rework needed when support lands (that is the whole point of per-token binding).

---

## 9. Testing strategy (mirrors `packages/mcp-server/test/*` + `packages/core/test/security/*`)

Convention observed: real SDK client against a real in-process server on an ephemeral port (`http-transport.test.ts:1-12`), `DummyDataProvider`, `:memory:` audit/approval, injected clock/fakes rather than mocks at the transport boundary.

**Unit (`packages/mcp-server/test/oauth/`):**
- `metadata.test.ts` — emitted PRM/AS docs `.parse()` clean against `OAuthProtectedResourceMetadataSchema` / `OAuthMetadataSchema`; assert `code_challenge_methods_supported === ['S256']`, `dpop_bound_access_tokens_required !== true`.
- `scope-minter.test.ts` — mints from profile; **ignores a client-supplied scope** (pass a bogus `params.scopes`, assert output unchanged); deterministic; `spending`-bearing profile ⇒ high-sensitivity scope.
- `provider.test.ts` — `authorize()` with a fake auto-approve `ConsentFn` creates a single-use pending grant; `exchangeAuthorizationCode` redeems once then **rejects a replay of the same code**; wrong PKCE `code_verifier` rejected; `verifyAccessToken` returns `AuthInfo` with `extra.profileId`; `revokeToken` ⇒ next `verifyAccessToken` throws.
- `dpop.test.ts` (M3) — thumbprint vector (RFC 7638 example), htu/htm/iat/jti validation, replayed jti rejected, bound-token-as-plain-Bearer rejected.

**Integration (`packages/mcp-server/test/oauth-flow.test.ts`):**
- Full `register → authorize (fake consent) → token → initialize /mcp with Bearer → tools/call` happy path over the real Express app with the real SDK client.
- **Unknown/blocked profile** (consent returns `no-eligible-profile`) ⇒ `authorize` error redirect ⇒ no token.
- Token minted for profile A carries only A's scopes; asserting via `verifyAccessToken` that B's high scope is absent (full A-can't-do-B enforcement is WS3's test, but the scope-minting half lives here).
- `401` on `/mcp` with no/expired/revoked token, and the `WWW-Authenticate` header points at the PRM URL.

**E2E:** deferred to WS6's already-landed mcp-remote path + a manual "Claude Desktop lists tools over the OAuth'd loopback" check (parent §6 E2E; also the D5.4 threat-model spoof/replay checks → consolidated `TEST-PLAN.md`).

---

## 10. Open questions / risks & security checklist

- **Express version / rate-limit dep.** SDK peers `express@^5.2.1` + `express-rate-limit@^8`. Decision needed: pass `rateLimit: false` to the SDK handlers (drop the `express-rate-limit` dep, fine for a single-user loopback AS) vs. keep the default. Lean **`rateLimit: false`** — a local single-user server doesn't need it and it's one fewer dep; revisit if the port is ever exposed beyond loopback (it must not be).
- **`issuerUrl` with a fixed loopback port.** RFC 8414 issuers are usually `https`. We are `http://127.0.0.1:<port>` (loopback exempt from the https requirement per the OAuth-for-native-apps guidance, BCP 212). Confirm mcp-remote/Claude accept an `http` loopback issuer — WS6's landed flow suggests yes, but assert in the E2E. Port stability is already solved (fixed `DEFAULT_MCP_HTTP_PORT` 8765, parent §7.4 / `mcp-loopback.ts:9`).
- **Consent for an unattended DCR client.** Claude/mcp-remote open a browser for `/authorize`; our `authorize()` must drive a *desktop* consent window (WS4), not an HTTP-rendered page, because the secret/profile binding is a main-process decision. The `ConsentFn` seam keeps that out of WS2. Risk: if the desktop app isn't running, `/authorize` can't get consent — acceptable (same "only works while Clad runs" constraint as the loopback child, `claude-desktop-config.ts:36`).
- **Security checklist (`packages/docs/plans/desktop-app.md`):**
  - *No plaintext secrets at rest / 0600:* access/refresh tokens, client secrets, code challenges, jkt thumbprints all live in WS5's AES-256-GCM store — never on disk in plaintext, never in the audit DB, never over IPC to the renderer.
  - *redactSecrets on error paths:* OAuth error responses (`errors.ts`) must be RFC 6749 §5.2 shaped **and** passed through `redactSecrets` — never echo a token, code, or `code_verifier` in an `error_description`. Reuse `writeRedactedStderr` for stderr.
  - *Renderer never receives secrets:* the `ConsentFn` boundary passes only display-safe metadata (client name, profile ids, scope labels) — never a token or code.
  - *Loopback-only + DNS-rebinding guard preserved* across the Express port (§2.1).
- **Token/grant TTLs.** Auth code 60s single-use; access token short (e.g. 1h) with refresh; refresh rotation on use (store the new, delete the old) to bound a leaked-refresh window. Finalize in WS5's schema.
