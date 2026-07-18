# WS7 — KYA / `TrustProvider` seam (detailed design)

Parent: [`../D5.3-authenticated-agent-identity-plan.md`](../D5.3-authenticated-agent-identity-plan.md) §3 WS7, §7.3.
Relates to: [`WS2-oauth-resource-server.md`](WS2-oauth-resource-server.md) (the two call sites), [`WS5-grant-store.md`](WS5-grant-store.md) (where an assessment is persisted).
Status: **design / implementation-ready.**

**Scope discipline — read this first.** This workstream ships an **interface and one trivial implementation**, nothing more. It is explicitly *not* a KYA build (parent §3 WS7: "Keep this an **interface boundary**, not a full KYA build — that's a separate phase"). Its entire value is that when the KYA plan does arrive, it slots in behind an existing seam instead of forcing a refactor of the OAuth provider. Every design choice below optimizes for *small now, extensible later*, and the biggest risk in this WS is over-building it (§7).

**Current state re-confirmed (grep, 2026-07-18):** no `TrustProvider`, `trust_provider`, or KYA code exists anywhere in the repo. The only occurrences are plan prose — this file's parent (`D5.3-authenticated-agent-identity-plan.md:80-81,106,134`), the sibling WS docs' forward-references, and the roadmap line `packages/docs/plans/desktop-app.md:113` ("coordinates with the KYA / `TrustProvider` plan"). So this is a greenfield interface with no existing caller to accommodate.

---

## 1. Goal & acceptance advanced

Ensure the two decisions that *define* an agent's authority — **who is this client** and **what scope may it hold** — route through one named boundary rather than being hard-coded inside `CladOAuthProvider`.

D5.3 acceptance advanced (indirectly, as an architecture property rather than a new control):
- **#1 / #4:** identity verification and profile eligibility become a *pluggable, auditable decision* rather than an implicit consequence of "the user clicked approve". Today's answer is still "local human consent" — but it is now an answer produced by a named component.
- **#2:** scope minting is already server-side (WS2 §6); WS7 makes the *sensitivity ceiling* (which scopes a given client is even eligible for) a trust-level function, which is the natural place a future KYA attestation raises or lowers the bar.

Milestone mapping: lands with **M2** as a thin refactor of WS2's call sites (it has no independent user-visible behaviour), and is the designated extension point for post-D5.3 KYA work.

---

## 2. The two call sites (and only these two)

From WS2's design, exactly two functions decide authority. WS7 wraps them and nothing else:

| Decision | WS2 location today | WS7 routes it through |
| --- | --- | --- |
| Which profiles may this client be bound to, and with what assurance? | `CladOAuthProvider.authorize()` → builds `ConsentRequest.availableProfiles` (WS2 §3, `oauth/consent.ts`) | `TrustProvider.assessClient()` |
| What scope does this (profile, client) get? | `mintScopesForProfile(policy, profileId)` (WS2 §3, `oauth/scope-minter.ts`) | `TrustProvider.mintScopes()` |

Both were deliberately left as standalone functions in WS2 precisely so WS7 could wrap them without touching the provider (WS2 §7 "Dependencies", WS5 §6 "Dependencies"). WS3's `resolvePrincipal` is a *candidate* third call site (WS3 §7) — **deliberately excluded** for now: per-request principal resolution is a pure token-store lookup with no trust decision in it, and routing it through an async trust interface would put a policy hook on the hot path for no present benefit. Revisit only if KYA introduces per-request revalidation.

---

## 3. The interface

New file: `packages/core/src/security/trust-provider.ts` (sibling to `token-store.ts` / `grant-store.ts`, exported from `packages/core/src/index.ts`).

Placed in `@clad/core` rather than `@clad/mcp-server` because both the server (minting) and, later, the desktop app (displaying assurance level in the WS4 consent screen and connected-clients list) need the types, and `@clad/core` is the established shared home for security primitives (`token-store.ts:9-14` documents exactly this reasoning for the token store).

```ts
/**
 * The seam through which agent-identity verification and scope minting route.
 *
 * D5.3 ships ONE implementation (`LocalConsentTrustProvider`) whose entire
 * notion of trust is "a human approved this binding in the consent screen".
 * The interface exists so a future KYA plan can supply a richer implementation
 * (attestation, registry lookup, publisher verification) without touching the
 * OAuth provider. Do NOT grow this interface speculatively — see WS7 §7.
 */

/** What we know about a client asking to be bound to a profile. All fields are client-asserted EXCEPT `clientId` (server-issued at DCR) and `dpopJkt` (proven by possession). */
export interface AgentIdentityClaim {
  /** Server-issued at Dynamic Client Registration — the one non-spoofable handle. */
  clientId: string
  /** Self-reported at DCR. UNTRUSTED display text (WS4 §7). */
  clientName?: string
  /** Registered redirect URIs — weak signal, but a stable one across re-registrations. */
  redirectUris?: string[]
  /** RFC 7638 thumbprint of a DPoP key the client has proven possession of (M3); absent for bearer-only clients. */
  dpopJkt?: string
  /**
   * Opaque, implementation-defined attestation material. `unknown` on purpose:
   * D5.3 never reads it, and typing it now would bake in a guess about KYA's
   * eventual shape. A future provider narrows it internally.
   */
  attestation?: unknown
}

/** How much we believe the claim, and what that permits. */
export interface TrustAssessment {
  /**
   * `'none'` — nothing verified (should not reach a grant).
   * `'local-consent'` — a human on this machine approved the binding. The ONLY
   *   level D5.3 produces, and a genuinely meaningful one for a local-first app.
   * `'attested'` — reserved for KYA; never produced by D5.3's implementation.
   */
  assuranceLevel: 'none' | 'local-consent' | 'attested'
  /** Profiles this client may be bound to. D5.3: every profile in the policy (the human chooses among them). */
  eligibleProfiles: string[]
  /**
   * The highest scope sensitivity this client may hold, per parent §10's
   * "gate scope on binding, checked at enrollment". D5.3 derives this purely
   * from DPoP binding: bearer-only -> 'low'; DPoP-bound -> 'high'.
   */
  maxScopeSensitivity: 'low' | 'high'
  /** Display-safe explanation for the consent screen / audit. Never secret material. */
  reason?: string
}

export interface MintScopesRequest {
  profileId: string
  policy: PolicyConfig
  assessment: TrustAssessment
}

export interface TrustProvider {
  /** Called at /authorize, BEFORE the human consent screen is rendered. */
  assessClient(claim: AgentIdentityClaim): Promise<TrustAssessment>
  /** Called at /token (and on refresh). MUST NOT read any client-supplied scope. */
  mintScopes(req: MintScopesRequest): Promise<string[]>
}
```

### 3.1 The one implementation

`packages/core/src/security/trust-provider-local.ts`:

```ts
/**
 * D5.3's only TrustProvider: trust == a human approved it locally.
 *
 * Deliberately thin. It does not verify publishers, check registries, or
 * inspect `attestation` — those are KYA's job. What it DOES encode is the
 * parent plan's §10 enrollment gate: a bearer-only client can never be minted
 * a high-sensitivity (action-bearing) scope, regardless of the profile chosen.
 */
export class LocalConsentTrustProvider implements TrustProvider {
  async assessClient(claim: AgentIdentityClaim): Promise<TrustAssessment> {
    return {
      assuranceLevel: 'local-consent',
      eligibleProfiles: Object.keys(this.policy.agents),   // the human picks among all of them
      maxScopeSensitivity: claim.dpopJkt ? 'high' : 'low', // parent §10 gate
      reason: claim.dpopJkt
        ? 'Client proved possession of a DPoP key.'
        : 'Bearer-only client — high-privilege scopes are unavailable.',
    }
  }

  async mintScopes({ profileId, policy, assessment }: MintScopesRequest): Promise<string[]> {
    const all = mintScopesForProfile(policy, profileId)          // WS2 §6 — unchanged, still the derivation
    return assessment.maxScopeSensitivity === 'high'
      ? all
      : all.filter((s) => scopeSensitivity(s) === 'low')          // drop action-bearing scopes for bearer clients
  }
}
```

Note what this preserves: `mintScopesForProfile` remains the sole *derivation* of scope from policy (WS2 §6's invariant is intact). `TrustProvider.mintScopes` only *narrows* that set based on trust. Widening is structurally impossible — a useful property to state and test.

---

## 4. Wiring into WS2

Minimal, three edits:

1. `CladOAuthProviderDeps` (WS2 §3) gains `trust: TrustProvider`, constructed as `new LocalConsentTrustProvider(policy)` in `loadServerResources()` alongside the grant store.
2. `authorize()` calls `trust.assessClient({ clientId, clientName, redirectUris, dpopJkt })` first. If `assuranceLevel === 'none'` or `eligibleProfiles` is empty → error-redirect (`access_denied`) without rendering consent. Otherwise `ConsentRequest.availableProfiles = assessment.eligibleProfiles`, and the assessment's `reason` + `maxScopeSensitivity` inform the consent copy (WS4 §2.2 — e.g. greying out a profile whose scopes exceed the client's ceiling).
3. `exchangeAuthorizationCode()` / `exchangeRefreshToken()` call `trust.mintScopes({ profileId, policy, assessment })` instead of `mintScopesForProfile` directly.

**Persistence (WS5):** store the `assuranceLevel` and `maxScopeSensitivity` on `StoredGrant` at consent time, so (a) refresh re-mints against the *original* assessment rather than silently re-assessing, and (b) WS4's connected-clients list can display assurance. This is a two-column addition to WS5 §3's `StoredGrant` — flag it there. WS5 §6 already reserved that the columns stay provider-agnostic with no KYA-specific fields, which this respects.

---

## 5. Internal sequencing

1. **S1** — land `trust-provider.ts` (types only) + `trust-provider-local.ts` + `@clad/core` exports. Zero callers. Fully unit-testable in isolation.
2. **S2** — add the two `StoredGrant` columns in WS5.
3. **S3** — repoint WS2's `authorize` / `exchangeAuthorizationCode` / `exchangeRefreshToken` at the interface (the three edits in §4). Behaviour must be **identical** for a DPoP-bound client and *more restrictive* for a bearer-only one — that behaviour change is the parent §10 gate finally being enforced, and should be called out in the PR description rather than slipped in.
4. **S4** — WS4 consent screen surfaces `assuranceLevel` / `reason`.

### Dependencies
- **WS2** — the only consumer. WS7 S1 can land before or after WS2; S3 obviously requires WS2's provider to exist.
- **WS5** — S2's two columns.
- **WS4** — S4 display only; not blocking.
- **Not on the critical path.** If M2 is running late, ship WS2 calling `mintScopesForProfile` directly and land WS7 as a follow-up refactor — the seam is cheap to insert later *precisely because* WS2 kept both decisions as standalone functions. Say so explicitly in sequencing so this doesn't become a blocker.

---

## 6. Testing strategy

Conventions: pure-unit tests under `packages/core/test/security/` (`crypto.test.ts`, `token-store.test.ts` style — no I/O needed here at all, since this is a pure decision function).

**Unit (`packages/core/test/security/trust-provider-local.test.ts`):**
- `assessClient` returns `'local-consent'` and every policy profile as eligible.
- `maxScopeSensitivity` is `'high'` iff `dpopJkt` is present — the parent §10 gate, asserted directly.
- **`mintScopes` can only narrow, never widen:** for every profile in a fixture policy, the returned set is a subset of `mintScopesForProfile(policy, profileId)`. Property-style over all profiles — this is the single most important test in the WS.
- A bearer-only assessment drops action-bearing (`clad:actions.request`) scopes; a DPoP-bound one retains them.
- `mintScopes` ignores anything client-supplied (pass a bogus scope list nowhere in the signature — assert by construction that the signature has no client-scope parameter; the compile-time absence *is* the guarantee).
- `attestation` is never read (a claim carrying a hostile `attestation` value produces the same assessment as one without).

**Integration:** covered transitively by WS2's `oauth-flow.test.ts` once S3 lands — assert a bearer-only client cannot obtain an action-bearing scope end-to-end, and that this is the *only* observable behaviour change from the refactor.

---

## 7. Open questions / risks & security checklist

- **The primary risk is over-building.** Every field on `TrustAssessment` is a commitment the KYA plan must either use or deprecate. The version above has four fields and one implementation; resist adding registry ids, publisher names, signature blobs, or expiry semantics until KYA actually specifies them. `attestation?: unknown` is the intentional escape hatch that lets KYA carry arbitrary material without an interface change. **If a reviewer wants a field added, the default answer is "when KYA needs it".**
- **`assuranceLevel` is not a security control today.** It is metadata plus one gate (`maxScopeSensitivity`). Do not let UI or policy start branching on `'attested'` before anything can produce it — that would create a code path that has never executed. Assert in tests that `LocalConsentTrustProvider` never returns `'attested'`.
- **Re-assessment on refresh.** §4 stores the original assessment and re-mints against it. The alternative (re-assess on every refresh) would let a client's scope *change* mid-grant without human involvement — rejected. But note the consequence: if KYA later revokes trust in a client, that must flow through **grant revocation** (WS4/WS5), not through a silent re-assessment. Worth stating in the KYA plan's inputs.
- **Policy drift.** `StoredGrant.scopes` is minted at consent from the then-current policy (WS5 §3). If the user later tightens `policy.agents[profile]`, an existing grant's stored scope is stale. Today that's contained because `evaluator.ts` remains the real enforcement point and always reads live policy (`evaluator.ts:21,31`) — scope is advisory (WS2 §6). Keep it that way: **scope must never become the sole authority** while grants cache it. Re-check this if D5.2's field-shaping starts keying off scope.
- **Security checklist (`packages/docs/plans/desktop-app.md`):** `TrustAssessment.reason` is display-safe text that reaches the consent screen and the renderer — never embed a token, thumbprint-derived secret, or raw error; pass through `redactSecrets` if ever derived from a thrown value. The interface handles no secret material at all by design (`dpopJkt` is a public-key hash), which is itself worth preserving as an invariant.
