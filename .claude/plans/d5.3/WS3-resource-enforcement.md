# WS3 — Resource-layer enforcement: identity from token, not env (detailed design)

Parent: [`../D5.3-authenticated-agent-identity-plan.md`](../D5.3-authenticated-agent-identity-plan.md) §3 WS3, §2.
Depends on: [`WS2-oauth-resource-server.md`](WS2-oauth-resource-server.md) (produces the validated token / `req.auth`).
Status: **design / implementation-ready.**

The whole architectural bet (parent §2): *everything downstream of `agentId` stays identical* — `evaluator.ts`, audit, tools. WS3 changes **only where `agentId` comes from**: a per-request principal resolved from a verified token, instead of the process-constant `CLAD_AGENT_ID`. That containment is what makes this a small, surgical change despite being the security heart of D5.3.

---

## 1. Goal & acceptance advanced

Turn the token WS2 issues into the identity the resource layer enforces:
- **#1 (no id-spoofing):** `agentId` is read from `AuthInfo` (server-verified), never from env or a client claim, on the authenticated path.
- **#2 (scope binds to an authenticated client):** the per-request principal carries the token's `clientId` + scopes + (M3) `jkt`; audit records the authenticated principal.
- **#4 (policy keys off verified identity):** `evaluator.ts`'s `policy.agents[agentId]` lookup is fed the verified profile — with **zero change to `evaluator.ts` itself**.

Plus the provider gate (parent §3 WS3 final bullet): **only the authenticated HTTP path may construct a real (`plaid`/`simplefin`) provider; stdio stays dummy-only.**

Milestone mapping: the **M1 walking skeleton** is WS3's per-request plumbing with a static-bearer placeholder; the real wiring completes in **M2** once WS2's `verifyAccessToken` exists.

---

## 2. The seam (verified against SDK 1.29.0)

`StreamableHTTPServerTransport.handleRequest(req, res, body)` reads `req.auth` (`streamableHttp.js:131`, set by `requireBearerAuth`) and threads it into the Server request handler as `RequestHandlerExtra.authInfo` (`shared/protocol.d.ts:181`, `AuthInfo`). So the CallTool handler's **second argument already carries the verified principal** — no new transport plumbing is needed; we only have to *read* from `extra` instead of closing over `resources.agentId`.

`AuthInfo` (`server/auth/types.d.ts`): `{ token, clientId, scopes[], expiresAt?, resource?, extra? }`. WS2 stashes the resolved profile on **`extra`**:
```ts
// what CladOAuthProvider.verifyAccessToken returns (WS2 §4.5)
authInfo.extra = { profileId: string; jkt?: string }   // jkt is M3
```

Today the CallTool handler ignores `extra`/`authInfo` entirely and uses `resources.agentId` (`server-core.ts:176-186`). That is the exact line WS3 rewrites.

---

## 3. File-level changes

### `packages/mcp-server/src/server-core.ts` — the core change

Today (`:161-190`) `createConfiguredServer(resources)` closes over `resources.agentId` and passes it into every `handleToolCall`. Change so the CallTool handler derives `agentId` **per request** from `extra.authInfo`:

```ts
server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
  handleToolCall(request, {
    tools,
    agentId: resolvePrincipal(extra, resources),   // NEW — per request
    context: { policy: resources.policy, provider: resources.provider,
               auditLogger: resources.auditLogger, approvalQueue: resources.approvalQueue },
    auditLogger: resources.auditLogger,
  })
)
```

`resolvePrincipal` — the single place identity is decided:

```ts
/**
 * The verified agent-profile principal for THIS request.
 *  - HTTP + OAuth on: MUST come from extra.authInfo.extra.profileId (WS2-verified token).
 *  - stdio (dummy) path: no authInfo — falls back to resources.agentId (env), which
 *    is acceptable ONLY because that path is gated to the dummy provider (§5).
 * Never trusts a client-supplied id.
 */
function resolvePrincipal(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  resources: ServerResources,
): string {
  const profileId = (extra.authInfo?.extra as { profileId?: string } | undefined)?.profileId
  if (resources.authRequired && !profileId) {
    throw new UnauthenticatedError()   // -> surfaces as a tools/call error; belt-and-braces (requireBearerAuth already 401s first)
  }
  return profileId ?? resources.agentId
}
```

`ServerResources` (`:99-105`) gains:
```ts
export interface ServerResources {
  agentId: string                 // now only the stdio/dummy fallback
  authRequired: boolean           // true iff CLAD_MCP_AUTH=oauth (HTTP+auth path)
  oauth?: CladOAuthProvider        // WS2
  policy: PolicyConfig
  provider: FinancialDataProvider
  auditLogger: AuditLogger
  approvalQueue: ApprovalQueue
}
```

`handleToolCall` (`:62-90`) is **unchanged** — it already takes `agentId: string` as a dep and builds `ToolContext` from it (`:77`). It doesn't care that the value now originates from a token. Audit logging (`:83,87`) therefore records the verified principal automatically. This is the "downstream unchanged" property in action.

### `packages/mcp-server/src/types.ts` — optional principal enrichment
`ToolContext.agentId` (`:3`) stays a `string`. **Optionally** add read-only principal metadata for future field-shaping (D5.2) and richer audit, without disturbing existing tools:
```ts
export interface ToolContext {
  agentId: string
  principal?: { clientId: string; scopes: string[]; jkt?: string }  // NEW, optional — tools may ignore
  policy: PolicyConfig
  provider: FinancialDataProvider
  auditLogger: AuditLogger
  approvalQueue: ApprovalQueue
}
```
Keep this optional so none of the five existing tools (`clad_*`) need edits in WS3. Populate it in `handleToolCall` from the same `extra.authInfo`. (If it complicates the minimal change, defer `principal` to D5.2 — it is not required for acceptance #1/#2/#4.)

### `packages/mcp-server/src/server-core.ts` — `loadServerResources()` (`:119-150`)
- Read `authRequired = process.env.CLAD_MCP_AUTH === 'oauth'`.
- Keep the env `agentId` resolution (`:125`) as the **stdio/dummy fallback only**.
- Construct `resources.oauth` (WS2) only when `authRequired` (and transport is http).
- Keep the "agent not in policy → warn" check (`:143-147`) for the fallback path; on the authenticated path the profile is validated at consent time (WS2), and an unknown-profile token would never have been minted.

### `packages/mcp-server/src/provider-factory.ts` — the real-provider gate (§5)
Add an explicit guard so a real provider cannot be constructed on an unauthenticated transport.

---

## 4. Unauthenticated / static-bearer bridge (M1 walking skeleton)

Parent §4 M1 wants the transport swap + identity-from-request refactor proven **before** real OAuth. Implement `resolvePrincipal` and the `ServerResources.authRequired` flag first, with a trivial verifier:
- A dev-only `CLAD_MCP_STATIC_BEARER=<token>:<profileId>` that a placeholder middleware turns into `req.auth = { token, clientId: 'static', scopes: [], extra: { profileId } }`.
- This proves `evaluator.ts` keys off the request-derived profile with **no** OAuth machinery, exactly as parent §4 M1 describes. It is deleted (or gated to `NODE_ENV!=='production'`) once WS2's `requireBearerAuth` lands in M2.

---

## 5. The real-provider gate (stdio stays dummy-only)

Parent §3 WS3: the current loopback transport is unauthenticated (`http-transport.ts:22-29`) yet already serves the **real** SimpleFIN provider (that is the whole Approach-A interim fix). D5.3's end state must invert the risk: **a real provider is only reachable behind a verified token.** Two enforcement layers:

1. **Transport/auth gate (primary).** When `CLAD_PROVIDER` is `plaid`/`simplefin`, `loadServerResources` MUST require `authRequired === true` **and** `transport === 'http'`. Refuse to boot a real provider on stdio, or on http without auth:
   ```ts
   if (provider !== 'dummy' && !(transport === 'http' && authRequired)) {
     throw new Error('[clad server] A real provider requires the authenticated HTTP transport (CLAD_MCP_TRANSPORT=http, CLAD_MCP_AUTH=oauth).')
   }
   ```
   Put this in `provider-factory.ts`'s `createProvider()` (it already branches on `CLAD_PROVIDER`, `:21-38`) by threading in `{ transport, authRequired }`, so the gate sits next to the branch that would otherwise build the real adapter.
2. **Per-request principal gate (defence-in-depth).** `resolvePrincipal` throws `UnauthenticatedError` if `authRequired` but no `profileId`. Combined with `requireBearerAuth`'s 401, a request can only reach a real provider with a verified profile.

**Interim-fix transition (parent §9/§10):** during M1/M2 beta the flag defaults **off**, so the current unauthenticated-loopback-serving-real-SimpleFIN behaviour is unchanged (the beta accepts that risk — `http-transport.ts:22`). Flipping `CLAD_MCP_AUTH=oauth` on (M2 GA) is what activates the gate and supersedes the interim fix. The desktop app (`mcp-server-env.ts:94` sets `CLAD_MCP_TRANSPORT=http`) will additionally set `CLAD_MCP_AUTH=oauth` once M2 ships — a one-line change to `buildServerEnv`.

---

## 6. What explicitly does NOT change (the containment proof)

- `packages/core/src/policy/evaluator.ts` — `evaluate(agentId, …)` and `policy.agents[agentId]` (`:21,31`) untouched. It receives a trusted `agentId` now; it never knew where the id came from.
- The five tool handlers (`clad_get_balances`, `clad_get_transactions`, `clad_safe_to_spend`, `clad_request_action`, `clad_audit_log`) — no signature change; they read `context.agentId` as before.
- `AuditLogger.logRequest(agentId, …)` (`server-core.ts:83,87`) — same call, now logging the verified principal.
- The stdio transport (`server.ts:49-53`) — unchanged; `authRequired` is false there, principal falls back to env, provider is gated to dummy.

---

## 7. Internal sequencing

1. **S1** — add `authRequired` to `ServerResources`, implement `resolvePrincipal` with the static-bearer bridge (§4). Unit-test the resolver in isolation. *(M1)*
2. **S2** — the real-provider gate in `provider-factory.ts` (§5). Unit-test that stdio+plaid throws and http+auth+plaid is allowed.
3. **S3** — once WS2's `requireBearerAuth` + `verifyAccessToken` land, replace the static bridge with the real middleware; assert `extra.authInfo.extra.profileId` flows to `evaluator.ts`. *(M2)*
4. **S4** — optional `ToolContext.principal` enrichment (defer if it forces tool edits).

### Dependencies
- **WS2** provides `req.auth`/`AuthInfo.extra.profileId` (S3). WS3's S1–S2 can land first with the static bridge (that IS the M1 skeleton).
- **WS7** — `resolvePrincipal` is a candidate call site to route through `TrustProvider.resolvePrincipal(token)` later; keep it a single standalone function so WS7 can wrap it.
- No dependency on WS4/WS5 for the enforcement path itself (those are consent/storage).

---

## 8. Testing strategy (`packages/mcp-server/test/`)

Existing convention: real SDK client over an ephemeral loopback port, `DummyDataProvider`, `:memory:` DBs (`http-transport.test.ts:1-12`), and direct `handleToolCall` unit tests (the function was factored out for exactly this, `server-core.ts:58-61`).

**Unit:**
- `resolve-principal.test.ts` — profileId from `extra.authInfo.extra` wins; `authRequired && no profileId` throws; stdio fallback returns env `agentId`; a client-supplied id inside tool `arguments` is **never** consulted.
- `provider-gate.test.ts` — extends `provider-factory.test.ts`: `CLAD_PROVIDER=simplefin` on stdio throws; on http-without-auth throws; on http+auth is allowed (dummy still allowed everywhere).
- `handle-tool-call` (extend existing) — same `handleToolCall`, two different `agentId` values (profile A vs B) hit `evaluator.ts` and get A's vs B's decisions, proving downstream is identity-driven and unchanged.

**Integration (`packages/mcp-server/test/auth-enforcement.test.ts`):**
- With the static-bearer bridge (M1): a request carrying profile `analyst` gets analyst's policy decisions; a request carrying `admin` gets admin's — same server, same tools, different verified identity.
- **Cross-profile isolation (acceptance #1):** a token/principal for profile A cannot exercise a tool that only B's policy permits (deny from `evaluator.ts`), and the audit row records A, not B.
- After WS2 lands (M2): full authorize→token→`tools/call` shows the DB audit entry keyed on the **token's** profile, and a request with no `Authorization` header 401s before reaching any tool.

**Threat-model (D5.4, → `TEST-PLAN.md`):** "assert as another profile by id" (blocked — no id channel exists on the authed path), "reach a real provider without a token" (blocked by §5 gate).

---

## 9. Open questions / risks & security checklist

- **`extra` typing.** `AuthInfo.extra` is `Record<string, unknown>` — `resolvePrincipal` must narrow it defensively (`(extra.authInfo?.extra as {profileId?})?.profileId`) and treat a malformed/absent `profileId` as unauthenticated, never as a silent fallback on the authed path. Unit-test the malformed case.
- **Fallback-path safety.** The env `agentId` fallback is only sound while the real-provider gate (§5) holds. If that gate regressed, the dummy-only assumption breaks. Keep the gate and its test adjacent to the fallback so they can't drift apart.
- **Two-session concurrency.** The HTTP transport serves many sessions from one `resources` set (`http-transport.ts:16-18`), but `resolvePrincipal` is per *request* (per `extra`), so two clients as different profiles on the same process get independent identities — no shared mutable identity state. Assert with a two-client integration test.
- **Security checklist (`packages/docs/plans/desktop-app.md`):**
  - The principal object crossing into `ToolContext` carries **no secret** — `profileId`, `clientId`, scope labels, jkt thumbprint (a public-key hash, not a secret). The raw access token is not put on `ToolContext`.
  - Audit continues to redact args (`server-core.ts:83`) — unchanged.
  - Error text from `UnauthenticatedError` is a fixed, secret-free constant (mirrors `TokenStoreKeyError`'s discipline, `key-meta.ts:116`).
