# WS4 — Consent / enrollment + revocation UI (desktop) (detailed design)

Parent: [`../D5.3-authenticated-agent-identity-plan.md`](../D5.3-authenticated-agent-identity-plan.md) §3 WS4.
Depends on: [`WS2-oauth-resource-server.md`](WS2-oauth-resource-server.md) (the `ConsentFn` seam + `/authorize`), [`WS5-grant-store.md`](WS5-grant-store.md) (`listGrants`/`revokeGrant`/`GrantMeta`).
Status: **design / implementation-ready.**

Baseline: **WS1 + WS6 are shipped** (PR #68, merged to `main` as `58eda8d`). The loopback Streamable-HTTP transport and the `mcp-remote` connect entry exist in the working product, unauthenticated. WS4 is what turns that shipped-but-anonymous pipe into a human-approved, per-client, revocable grant.

Two distinct surfaces, deliberately split by trust boundary and lifecycle:
1. **Consent screen** — transient, per-authorization; the human step that binds a DCR client → an approved agent profile. Rendered as a **loopback-served HTML page in the system browser**, following the D3.1 Plaid-Link precedent.
2. **Connected-clients management** — persistent, in the desktop app's React renderer via typed IPC: list grants, show last-used, revoke.

---

## 1. Goal & acceptance advanced

- **#1 (no id-spoofing):** the consent screen is the *only* place a client→profile binding is created; the **user**, not the client, picks the profile. WS5 makes that binding immutable.
- **#3 (replayed/copied token rejected):** revoke → `revokeGrant` (WS5) → WS2's live `verifyAccessToken` 401s the next request. WS4 is the human trigger for that.
- **#4 (policy keys off verified identity):** consent is where the profile that WS3 later reads from the token is actually chosen.
- Standing checklist item 1: renderer sees **display-safe grant metadata only** (`GrantMeta`), never a token, client secret, or auth code.

Milestone mapping (parent §4): consent screen is **M2** (with the OAuth flow); revocation + connected-clients management spans **M2 → M4** (parent §4 M4, "revocation + hardening").

---

## 2. Consent screen — placement decision (BrowserWindow vs system browser)

**Decision: loopback-served HTML in the system browser, matching the D3.1 precedent.** Justification, reconciled against that precedent (`packages/desktop/src/main/lib/plaid-link-flow.ts:15-25`):

- **D3.1 chose the system browser** so a bank's existing session / 2FA / password-manager state is reused — a `BrowserWindow` "would have to either re-authenticate from scratch or reimplement a chunk of what a real browser already does for free" (`plaid-link-flow.ts:16-21`). That *specific* rationale doesn't transfer: binding a local agent profile needs no third-party session. But the **mechanism** does transfer exactly, and for an independent reason: **`mcp-remote` already opens the client's browser at the `/authorize` URL** as part of the OAuth 2.1 dance (parent §3 WS6; `claude-desktop-config.ts:21`). The AS *is* an HTTP server, so the natural consent surface is an HTML response from it, in the browser the client already launched. This is the same "loopback server serves HTML, `shell.openExternal` hands it to the real browser" shape D3.1 built.
- **Why not a native `BrowserWindow` owned by the main process:** the OAuth AS runs inside the **supervised mcp-server child** (it holds the passphrase, the policy, and the grant store — `mcp-server-env.ts:99-108`, `mcp-server-manager.ts`); the main process does not run the AS. A native window would require a new reverse child→main coordination channel purely to ask a question and await an answer, mid-HTTP-request. Serving HTML from the child keeps authorize → consent → code in one process and one request lifecycle. The trade-off (a native window is marginally harder to spoof) is mitigated in §2.2 and flagged for D5.4 in §6.

### 2.1 Flow (who serves what)

```
Claude Desktop -> mcp-remote --(opens system browser)--> GET /authorize?…&state&code_challenge
  child (CladOAuthProvider.authorize) -> renders consent HTML (profiles + per-profile scope preview)
  user picks profile + Approve -> POST /authorize/decision (csrf + state)
  child: bindClientProfile(clientId, profileId) [WS5, set-once] ; createGrant ; putAuthCode
         -> 302 redirect_uri?code&state
  mcp-remote catches the redirect on its loopback callback -> POST /token -> real data
```

The consent HTML is produced by WS2's `ConsentFn` implementation for the child (`packages/mcp-server/src/oauth/consent.ts`). Critically, `authorize()` **does not** call `res.redirect` immediately: it writes the consent page and returns, holding the authorization pending; the `POST /authorize/decision` route resolves that pending consent and issues the redirect. This is the same "loopback server holds the flow open until the human acts, then redirects" structure as `plaid-link-flow.ts` + its served page.

### 2.2 Consent-page content & anti-spoofing

- **Content** (all display-safe, derived from `policy.agents` + `mintScopesForProfile`): the reported client name, the selectable profiles, and a plain-language scope preview per profile — mirroring parent §3 WS4's copy: *"«Claude Desktop» wants to connect as profile «analyst» with: read balances, read transactions (90-day lookback), request actions ≤ $X. Approve?"* The amounts and lookbacks come from `policy.agents[profile].permissions` — the same fields `evaluator.ts` enforces (`packages/core/src/policy/evaluator.ts:107-156`), so the preview cannot drift from what will actually be allowed.
- **CSRF / state binding:** the page embeds the OAuth `state` plus a one-time CSRF token tied to the pending authorization; `POST /authorize/decision` rejects a mismatch. The loopback-`Host` guard still applies (`packages/mcp-server/src/http-transport.ts:87,184`). This matches the shipped beta threat model — same-OS-user local processes are already trusted (`http-transport.ts:22-29`) — while defending against a *browser page from another origin* auto-submitting a decision.
- **No secrets on the page:** no token, no client secret, no authorization code. The code is delivered only via the post-approval 302 to the pre-registered `redirect_uri`.

---

## 3. What the shipped connect flow's agent selector becomes

Today, post-#68, `ConnectClaudeDesktop.tsx` shows an agent selector fed by `ClaudeDesktopConnectPreview.availableAgentIds` / `resolvedAgentId` (`packages/desktop/src/shared/ipc.ts:164-175`), but the written `mcp-remote` entry deliberately carries **no** `CLAD_AGENT_ID`: identity is the supervised child's single env-asserted id, and "the connect UI's agent selector is informational until then" (`packages/desktop/src/main/lib/claude-desktop-config.ts:40-44`). WS4 is the "then".

**The migration:**
- The selector **stops being a config-write input** and stops being informational-only. Agent identity is no longer a property of the config entry at all — it is a property of the **grant**, chosen at consent time, per client.
- `ClaudeDesktopConnectPreview.availableAgentIds` / `resolvedAgentId` / `agentFallbackReason` (`ipc.ts:171-175`) become **redundant for the write path**. Keep them only if the connect screen wants to *preview* which profiles will be offered on the consent page; otherwise deprecate them from the preview type once M2 is on by default. The `buildCladMcpServerEntry` output is already agent-free (`claude-desktop-config.ts:84-95`), so **no change to the written entry is needed** — the plan's containment holds here too.
- The connect screen's copy changes from "connect as «profile»" to "connect Claude Desktop, then approve which profile it gets in the browser". The screen gains a pointer to the new Connected-clients section (§4.3) for post-connect management.
- The doc-comment constraints in `claude-desktop-config.ts:35-44` need updating when M2 flips on: the "loopback port is UNAUTHENTICATED for now" and "agent selector is informational" notes both expire. Treat that comment edit as part of the M2 PR, not a follow-up.

---

## 4. Connected-clients management — React renderer + IPC

### 4.1 New IPC contract (`packages/desktop/src/shared/ipc.ts` — extended in place)

Following that file's standing rules — display-safe only, standalone copies, never import from `src/main/**` (`ipc.ts:10-30, 358, 474-476`):

```ts
// ---- Connected clients / OAuth grants (D5.3 WS4) --------------------------

/**
 * Display-safe view of one issued OAuth grant. Standalone copy of @clad/core's
 * `GrantMeta` (same layering rule as `LinkedItem`/`ApprovalListItem` above).
 * NEVER a token, client secret, or authorization code.
 */
export interface ConnectedClient {
  grantId: string
  /** Self-reported by the client at DCR — untrusted display text; see WS4 §6. */
  clientName?: string
  /** The bound agent profile — server-chosen at consent, immutable. The trustworthy field. */
  profileId: string
  /** Minted server-side from policy (WS2 §6); rendered as friendly labels. */
  scopes: string[]
  /** M3: whether this grant's token is sender-constrained (DPoP-bound). */
  dpopBound: boolean
  createdAt: string
  /** Last time a request presented a token for this grant; `null` if never used. */
  lastUsedAt: string | null
  revoked: boolean
}

export interface RevokeClientResult {
  ok: boolean
  /** Display-safe (redacted where derived from stored/thrown data). */
  error?: string
}

// IPC_CHANNELS additions:
//   connectedClientsList:    'oauth:listClients'
//   connectedClientsRevoke:  'oauth:revokeClient'
//   connectedClientsChanged: 'oauth:clientsChanged'   // push-only main -> renderer

// CladBridge additions:
//   listConnectedClients(): Promise<ConnectedClient[]>
//   revokeConnectedClient(grantId: string): Promise<RevokeClientResult>
//   onConnectedClientsChanged(cb: (clients: ConnectedClient[]) => void): () => void
```

### 4.2 Main-process handlers

Registered alongside the existing block in `packages/desktop/src/main/index.ts` (`:522-863`):

```ts
ipcMain.handle(IPC_CHANNELS.connectedClientsList, () => listConnectedClients())
ipcMain.handle(IPC_CHANNELS.connectedClientsRevoke,
  (_e, grantId: string): RevokeClientResult => revokeConnectedClient(grantId))
```

New main-process module `packages/desktop/src/main/lib/connected-clients.ts` — a sibling of `connection-management.ts`, which already does the analogous list/remove for provider items (`ipc.ts:689-696`), so the shape is established:

- Opens the shared `SqliteGrantStore` with the already-resolved token-store passphrase (WS5 §3) — **no new key custody**.
- `listConnectedClients()`: `store.listGrants()` → map `GrantMeta` → `ConnectedClient`. `lastUsedAt` comes primarily from the grant store's own per-grant `touchGrant` value, optionally sanity-checked against the newest `AuditLogger` row for that `agentId` (the audit log records the *verified* principal once WS3 lands — parent §3 WS3). Never selects a secret column (WS5's `GrantMeta` has none by construction).
- `revokeConnectedClient(grantId)`: `store.revokeGrant(grantId)` (cascade-deletes tokens + codes, WS5 §3), then pushes `connectedClientsChanged`. Because the child's `verifyAccessToken` is a **live** store lookup, the revoke takes effect on its very next request — no restart, no cache to invalidate. Never rejects; returns `{ ok: false, error }` on a store failure, matching `removePlaidItem`'s convention (`ipc.ts:691`).

**Cross-process note** (same risk as WS5 §8): the main process writes the revoke; the child reads on next request. One SQLite file, two processes — rely on SQLite's file locking and keep writes short. Revoke-while-child-is-mid-issue is the concurrency case to test (§5).

### 4.3 Renderer (`packages/desktop/src/renderer/src/components/`)

New `ConnectedClients.tsx`, styled after `ApprovalsInbox.tsx` / `ConnectView.tsx`. Placement: a section on the existing **Connect** screen, which already owns linked-provider management and the Claude-Desktop connect entry (`ConnectView.tsx`, `ConnectClaudeDesktop.tsx`) — that keeps "what is connected to Clad" in one place, and sits directly beside the §3 copy changes.

Each row: reported client name, bound profile, scope chips, DPoP-bound badge (M3), created + last-used, and a **Revoke** button behind a confirm ("Claude Desktop will lose access immediately"). Subscribe to `onConnectedClientsChanged` for live updates — the same subscribe/unsubscribe shape as `onMcpStatusChanged` (`ipc.ts:646-652`). Degraded state when the grant store is unavailable (passphrase unresolved or undecryptable — WS5 §5), reusing the Connect screen's existing `'unavailable'` treatment (`ipc.ts:445-450`) rather than inventing a new error surface.

---

## 5. Internal sequencing

1. **S1 — grant-store read path (main).** `connected-clients.ts` `listConnectedClients()` over WS5's `listGrants` + audit enrichment; `list` IPC channel; read-only `ConnectedClients.tsx`. *Testable as soon as WS5 lands — before any consent UI exists.*
2. **S2 — revoke.** `revokeConnectedClient` + confirm UI + `connectedClientsChanged` push. Immediate-rejection integration test against the child.
3. **S3 — consent screen.** WS2's real `ConsentFn` in the child: consent HTML, `POST /authorize/decision`, CSRF/state, `bindClientProfile` + redirect. *Depends on WS2's authorize plumbing.*
4. **S4 — connect-flow migration (§3).** Repoint the agent selector's meaning, update `ConnectClaudeDesktop.tsx` copy, and refresh the now-expired doc comments in `claude-desktop-config.ts:35-44`.
5. **S5 — enrollment polish.** Client-name display, scope-label humanization, DPoP-bound badge (M3).

### Dependencies
- **WS5** (`listGrants` / `revokeGrant` / `GrantMeta`) — hard predecessor for the management surface (S1–S2).
- **WS2** (`ConsentFn`, `/authorize`) — hard predecessor for the consent screen (S3). WS2 lands with a *fake* auto-approve `ConsentFn`; WS4 S3 supplies the real one. That ordering is what lets WS2 be fully tested before any UI exists.
- **WS3** — supplies the verified `agentId` in the audit log that enriches `lastUsedAt`. Not blocking: `lastUsedAt` works from the grant store's own `touchGrant` alone.

---

## 6. Testing strategy

Conventions followed: main-process libs tested under Vitest with DI'd deps over temp files (`packages/desktop/test/connection-management.test.ts`, `passphrase-custody.test.ts`); pure functions over temp paths for anything that would otherwise touch a real external config (`claude-desktop-config.test.ts`, per D1.4's "do NOT write to the user's REAL Claude Desktop config" constraint, `claude-desktop-config.ts:47-52`).

**Unit (`packages/desktop/test/connected-clients.test.ts`):**
- `listConnectedClients` maps `GrantMeta` → `ConnectedClient` with **no secret field present** (assert the serialized object's key set exactly).
- `lastUsedAt` picks the grant's own value; `null` when never used.
- `revokeConnectedClient` calls `store.revokeGrant` and returns `{ ok: true }`; a store error returns a redacted `{ ok: false, error }` and **never throws**.
- Degraded path: grant store unavailable → empty list + display-safe reason, no crash (mirrors `passphrase-custody.test.ts`'s undecryptable cases).

**Unit (`packages/mcp-server/test/oauth/consent.test.ts`):**
- Consent HTML lists exactly `Object.keys(policy.agents)` and the `mintScopesForProfile` preview for each; contains no token, secret, or code (substring assertions).
- `POST /authorize/decision` with mismatched CSRF/state is rejected.
- Approve → binds the client **once** (a second bind attempt with a different profile is rejected — WS5 §7) and 302s to the registered `redirect_uri` with `code`+`state`.
- Deny → 302s with `error=access_denied`; no grant row, no token.

**Integration:**
- Full authorize → consent (approve profile A) → token → `/mcp` call as A; then **revoke via the desktop path** → the next `/mcp` call 401s. This is acceptance #3 demonstrated end-to-end across both processes, and is the single most valuable test in this workstream.
- Concurrent revoke + token-issue: the outcome is consistent and revoked-wins on the next lookup.

**E2E (manual, → `TEST-PLAN.md`):** Claude Desktop's OAuth prompt drives the system-browser consent page; approve; the Connected-clients list shows the client bound to the chosen profile; revoke; Claude Desktop's next tool call fails cleanly (not a hang, not stale data).

---

## 7. Open questions / risks & security checklist

- **Consent-surface trust.** Serving consent HTML on loopback is consistent with the shipped beta threat model (`http-transport.ts:22-29`), but a native window is stronger anti-spoofing for a grant over financial data. The `ConsentFn` seam (WS2 §3) abstracts *how* consent is obtained, so a native-window implementation can replace the HTML one later without touching the AS. **Flag for D5.4 review.**
- **Client identity display.** DCR clients self-report `client_name`; it is **attacker-controllable**. Escape it, label it as reported, and never let it imply verification. The server-chosen `profileId` is the trustworthy field — the UI hierarchy should reflect that.
- **Last-used accuracy.** Audit-by-`agentId` is coarse when two clients share one profile; prefer the grant store's per-grant `lastUsedAt` as primary and say "last used" is per grant, not per profile.
- **Revoke race.** Main-process revoke vs. child mid-issue on one SQLite file (§4.2). Keep both writes short; covered by the concurrency test above.
- **Doc-comment debt.** `claude-desktop-config.ts:35-44` documents the unauthenticated-port and informational-selector constraints as current truth. They expire when M2 flips on; updating them belongs in the same PR (§5 S4), or the file actively misleads.
- **Security checklist (`packages/docs/plans/desktop-app.md`):** renderer receives only `ConnectedClient` (no token / secret / code — `ipc.ts:10-19`); the consent page emits no secret; all error strings redacted before crossing IPC; loopback bind + DNS-rebinding guard + CSRF/state on the decision POST all preserved.
