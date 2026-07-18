# D5.3 — Consolidated sequencing, dependency graph, and risk register

Parent: [`../D5.3-authenticated-agent-identity-plan.md`](../D5.3-authenticated-agent-identity-plan.md) §4 (milestones), §8 (effort).
Per-workstream detail: [WS2](WS2-oauth-resource-server.md) · [WS3](WS3-resource-enforcement.md) · [WS4](WS4-consent-revocation-ui.md) · [WS5](WS5-grant-store.md) · [WS7](WS7-trustprovider-seam.md)

Baseline: **WS1 (loopback Streamable-HTTP transport) and WS6 (mcp-remote connect entry) are shipped** — PR #68, merged to `main` as `58eda8d`. Everything below builds on that substrate; nothing below re-plans it.

---

## 1. Dependency graph

```
                     ┌──────────────────────────────┐
                     │ SHIPPED: WS1 transport (#68) │
                     │ SHIPPED: WS6 mcp-remote (#68)│
                     └───────────────┬──────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
   ┌────▼─────┐                 ┌────▼─────┐                      │
   │   WS5    │                 │   WS3    │  (S1–S2 only:        │
   │ grant    │                 │ per-req  │   static-bearer      │
   │ store    │                 │ principal│   bridge + provider  │
   │ (LEAF —  │                 │ + gate   │   gate = the M1      │
   │  no deps)│                 └────┬─────┘   walking skeleton)  │
   └────┬─────┘                      │                            │
        │                            │                            │
        │  ┌─────────────────────────┘                            │
        │  │                                                      │
   ┌────▼──▼──────────────────────────────────────────────────────▼┐
   │                          WS2                                  │
   │   OAuth AS+RS: metadata, DCR, /authorize, /token, /revoke      │
   │   (Express port + mcpAuthRouter + CladOAuthProvider)           │
   └────┬──────────────────────────────────┬───────────────────┬───┘
        │                                  │                   │
   ┌────▼─────┐                       ┌────▼─────┐        ┌────▼─────┐
   │   WS4    │                       │  WS3 S3  │        │   WS7    │
   │ consent  │  (real ConsentFn      │ real     │        │ Trust    │
   │ + revoke │   replaces WS2's      │ bearer   │        │ Provider │
   │   UI     │   fake auto-approve)  │ wiring   │        │  seam    │
   └──────────┘                       └──────────┘        └──────────┘
```

**Critical path:** `WS5 → WS2 → {WS4, WS3-S3}`. WS5 is the only true leaf and the only hard blocker for WS2's substantive sub-steps (WS2 §7 marks it a hard predecessor for S3–S6). WS7 is explicitly **off** the critical path (WS7 §5).

**Two deliberate decouplings** that let work proceed in parallel:
- WS2 lands with a **fake auto-approve `ConsentFn`** (WS2 §7 S4), so the entire OAuth flow is testable before WS4's UI exists. WS4 then supplies the real one.
- WS3 S1–S2 land with a **static-bearer bridge** (WS3 §4), so the identity-from-request refactor is proven before any OAuth machinery exists. That *is* the M1 skeleton.

---

## 2. PR breakdown mapped to milestones

Parent §8: "Plan for four+ reviewable PRs across WS1–WS7, not a single change." Below is nine, sized for review rather than four mega-drops. Each row is independently mergeable and leaves `main` working (the beta's stdio+dummy default path is untouched until PR 8).

### M1 — Walking skeleton (no security value yet)

| PR | Scope | Workstream | Reviewable claim |
| --- | --- | --- | --- |
| **1** | Per-request principal: `resolvePrincipal`, `ServerResources.authRequired`, static-bearer dev bridge | WS3 S1 | "`agentId` now comes from the request, not the process — proven with a fake token, zero OAuth." |
| **2** | Real-provider gate: `plaid`/`simplefin` require http+auth; stdio is dummy-only | WS3 S2 | "A real provider is unreachable except behind the authenticated transport." |

M1 exit: `evaluator.ts` demonstrably keys off a request-derived profile; two clients on one process get independent identities (WS3 §8). Flag still defaults **off** — no user-visible change.

### M2 — Real OAuth, bearer only (the bulk)

| PR | Scope | Workstream | Reviewable claim |
| --- | --- | --- | --- |
| **3** | `SqliteGrantStore`: clients, grants, hashed tokens, single-use codes, revoke cascade, 0600 + key-check | WS5 S1–S3 | "Encrypted, 0600 OAuth state with the same invariants as `token-store.ts`." |
| **4** | **Express port** of the HTTP transport — no auth yet, behaviour-identical | WS2 S1 | "Same transport, same tests green, now on Express so SDK auth handlers can mount." |
| **5** | `mcpAuthRouter` + metadata + DCR wired to the grant store | WS2 S2–S3 | "RFC 9728/8414 docs validate against SDK schemas; `/register` round-trips." |
| **6** | `CladOAuthProvider`: authorize (fake consent) + token + PKCE + scope minting + `verifyAccessToken` + revoke | WS2 S4–S6 | "Full authorize→token→call happy path; replayed code rejected; revoke ⇒ immediate 401." |
| **7** | Real consent screen + `bindClientProfile`; connected-clients list + revoke UI + IPC | WS4 S1–S3 | "A human binds client→profile; the user can see and revoke it." |
| **8** | **Flip the flag**: `CLAD_MCP_AUTH=oauth` in `buildServerEnv`; connect-flow copy + expired doc comments | WS3 S3, WS4 S4 | "The shipped loopback path is now authenticated; interim fix superseded." |

M2 exit: **acceptance #1 and #4 met** (parent §4). mcp-remote + Claude Desktop fetch real SimpleFIN data through the OAuth'd server.

### M3 — Sender-constrained

| PR | Scope | Workstream | Reviewable claim |
| --- | --- | --- | --- |
| **9** | DPoP: proof parse/verify, `jkt` binding, jti replay cache, downgrade-safe enforcement, scope gate | WS2 §8 | "A DPoP-bound token cannot be replayed as plain Bearer." |

**Gated on parent §7.1** — confirm the pinned `mcp-remote` can present a DPoP proof. If it cannot, PR 9 still lands (the server-side capability is real and per-token), but its practical effect locally is only that high-sensitivity scopes stay unmintable. Acceptance #2 is met server-side; **#3 remains aspirational until client support exists** (parent §10 closing).

### M4 — Hardening

| PR | Scope | Workstream |
| --- | --- | --- |
| **10** | `TrustProvider` seam + `LocalConsentTrustProvider` + the two `StoredGrant` columns | WS7 (all) |
| **11** | D5.4 threat-model verification suite | → `TEST-PLAN.md` |

**Insertion note:** WS7 PR 10 can move earlier (any time after PR 6) — it is a pure refactor with one behaviour change (bearer-only clients lose action-bearing scopes, WS7 §5 S3). Landing it *before* PR 8's flag flip is mildly preferable so the gate is live from the first authenticated day.

---

## 3. Risk register

Ordered by expected cost (likelihood × blast radius), not by workstream.

| # | Risk | Likelihood | Impact | Where analysed | Mitigation / trigger |
| --- | --- | --- | --- | --- | --- |
| R1 | **Express port regresses the shipped loopback transport** (#68 is live in the beta; `isLoopbackHost`, 0.0.0.0-never, body cap, redacted stderr must all survive) | Med | **High** — breaks a shipped path | WS2 §2.1 | PR 4 is *behaviour-identical, no auth*, with the existing `http-transport.test.ts` as the gate. Do not combine with PR 5. Explicit checklist of the four preserved invariants in the PR description. |
| R2 | **mcp-remote / Claude reject an `http://127.0.0.1` OAuth issuer** (RFC 8414 expects https; loopback exempt per BCP 212, but unverified against these clients) | Med | **High** — blocks the whole delivery vehicle | WS2 §10 | Verify in PR 5 with a real mcp-remote against the metadata endpoints *before* building PR 6 on the assumption. Cheap early probe; expensive late discovery. |
| R3 | **Client DPoP support absent** ⇒ acceptance #3 unmet | **High** (already known true) | Med — an acceptance criterion stays open | Parent §7.1, §10; WS2 §8 | Already decided: bearer-baseline, never mandate. Track as a known-open acceptance item with a written rationale rather than a bug. Re-check at M3. |
| R4 | **Cross-process SQLite contention** on `grants.sqlite` — main-process revoke vs. child token-issue | Med | Med — a revoke could appear not to take | WS5 §8, WS4 §4.2 | Keep both writes short; explicit concurrent revoke+issue test (WS4 §6). Revoked-wins on next lookup is the required outcome. |
| R5 | **Scope becomes load-bearing while grants cache it** — stored scope goes stale when policy tightens | Low now, **rises with D5.2** | High if it happens | WS7 §7, WS2 §6 | Invariant: `evaluator.ts` remains sole enforcement, always reading live policy (`evaluator.ts:21,31`). Re-review the moment D5.2 field-shaping starts keying off scope. |
| R6 | **Consent page spoofable** (loopback HTML rather than a native window) | Low | Med | WS4 §2.2, §7 | CSRF+state binding, loopback Host guard, no secrets on page. `ConsentFn` seam allows a native-window swap with no AS change. Flagged for D5.4 review. |
| R7 | **safeStorage/Keychain churn** on unsigned rebuild makes the grant store unopenable | Med (routine in dev) | Low | WS5 §5, parent §7.5 | Rides the *existing* `PassphraseCustody.probeCustody()` degradation — no new failure mode. UI degrades to "re-connect"/empty, never crashes. No migration, by prior owner decision (`plaid-secrets.ts:41-46`). |
| R8 | **WS7 over-built** — speculative fields become commitments KYA must honour | Med | Low-Med | WS7 §7 | Four fields, one implementation, `attestation?: unknown` as the escape hatch. Default answer to "add a field" is "when KYA needs it". |
| R9 | **`AuthInfo.extra` malformed/absent** silently falls back to env identity on the authed path | Low | **High** — silent auth bypass | WS3 §9 | `resolvePrincipal` throws `UnauthenticatedError` when `authRequired && !profileId`; never falls back. Dedicated malformed-`extra` unit test. Fallback safety depends on R-gate (PR 2) holding — keep gate + fallback tests adjacent. |
| R10 | **Doc-comment drift** — `claude-desktop-config.ts:35-44` states "unauthenticated" / "selector informational" as current truth | High if unmanaged | Low | WS4 §3, §7 | Comment updates ship **inside PR 8**, not as follow-up. |
| R11 | **D5.2 not landed first** ⇒ verified identity still returns unshaped payloads | — | Med — halves the value | Parent §5 | Accepted sequencing risk, already documented. D5.3 is most valuable stacked on D5.2; does not block D5.3 correctness. |

---

## 4. Standing invariants (must hold at every PR boundary)

Drawn from `packages/docs/plans/desktop-app.md`'s security checklist and the existing code's discipline. Any PR touching these restates its compliance:

1. **Loopback only.** Bind `127.0.0.1`, never `0.0.0.0`; non-loopback `Host` ⇒ 403 (`http-transport.ts:87,184`).
2. **No plaintext secret at rest.** Tokens hashed, secrets AES-256-GCM'd, files 0600, key-check on open (WS5 §4).
3. **Renderer never receives secrets.** Only `ConnectedClient`/`GrantMeta`-shaped display-safe data crosses IPC (`ipc.ts:10-19`).
4. **`redactSecrets` on every error path**, including OAuth error responses (WS2 §10).
5. **Secret-free error messages** — fixed constants, the `TokenStoreKeyError` discipline (`key-meta.ts:116`).
6. **Downstream of `agentId` unchanged.** `evaluator.ts`, the five tools, and audit logging keep their signatures — the containment claim in parent §2 is the thing that makes this tractable, and every PR should be checkable against it.
