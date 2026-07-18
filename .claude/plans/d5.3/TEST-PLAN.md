# D5.4 — Consolidated threat-model verification plan

Parent: [`../D5.3-authenticated-agent-identity-plan.md`](../D5.3-authenticated-agent-identity-plan.md) §6.
Roadmap source: `packages/docs/plans/desktop-app.md:116-117` (D5.4), with the interlocking tasks at `:107` (D5.1), `:110` (D5.2), `:113` (D5.3).
Per-workstream test sections: [WS2 §9](WS2-oauth-resource-server.md) · [WS3 §8](WS3-resource-enforcement.md) · [WS4 §6](WS4-consent-revocation-ui.md) · [WS5 §7](WS5-grant-store.md) · [WS7 §6](WS7-trustprovider-seam.md)

D5.4's requirement, quoted exactly (`desktop-app.md:116-117`):

> Confirm the three gaps are closed *together*: no plaintext financial data readable out-of-band (D5.1); shaping holds even against a direct cache read (D5.1 + D5.2); an agent cannot spoof a profile (D5.3). **A gap in any one undermines the other two.**
> Acceptance: a written threat-model note (in the style of the S0 spike results) recording each check and its result.

So D5.4 is **not** a D5.3 test suite. It is a *joint* verification across D5.1 + D5.2 + D5.3, and its deliverable is a **written note**, not just green CI. This file plans the checks and the note's structure; D5.3's own per-WS unit/integration tests (linked above) are the substrate it draws on, not a substitute for it.

---

## 1. Deliverable and format

A `packages/docs/plans/` note (or a "D5.4 results" section appended to `desktop-app.md`, matching how S0 spike results were recorded inline at `:67-73`). Style requirements taken from the S0 precedent:

- **Each check gets a verdict, not a narrative** — the S0 results lead with `S0.2 — … : GO, no fallback needed.` then explain. Mirror that: `T1 — profile spoofing via env: BLOCKED.`
- **Assert content, not absence of throw.** S0.2 explicitly verified "by asserting the item content, not just 'no throw'" (`:67`). Every check below must assert the *observed value* an attacker would get, not merely that an error occurred.
- **Record what was actually run**, including build mode (dev / built `out/` / packaged unsigned), because S0 found behaviour that differed across exactly those three (`:67`).
- **Findings that aren't blockers still get written down** — S0's most valuable output was the ESM/CJS finding, which wasn't the question being asked.

---

## 2. Preconditions

D5.4 cannot be run meaningfully until all three land. Current status:

| Task | Status | Blocking D5.4? |
| --- | --- | --- |
| D5.1 encrypted cache | pulled forward into H0 (`desktop-app.md:107`) — **verify landed before running** | Yes — checks T4/T5 are vacuous without it |
| D5.2 field shaping | future work | Yes — check T6 is vacuous without it |
| D5.3 authenticated identity | this plan; M2 minimum, M3 for T3 | Yes — checks T1–T3 |

**Sequencing consequence:** run D5.4 after D5.3 M2 lands *if* D5.1+D5.2 are already in. Checks T1, T2, T4, T5, T6, T7, T8 are all satisfiable at M2. **T3 (replay) is the sole M3-gated check**, and per parent §10 it is expected to record a *qualified* result — see §4.

---

## 3. The check matrix

Each check names the attacker capability assumed, the concrete procedure, and the pass condition. Attacker model throughout: **a local process running as the same OS user**, plus a malicious/compromised MCP client. (This is the model the shipped beta already assumes — `http-transport.ts:22-29` — and is the honest one for a local-first desktop app: an attacker with root or a different user account is out of scope.)

### Group A — Agent cannot spoof a profile (D5.3)

| ID | Check | Procedure | Pass condition |
| --- | --- | --- | --- |
| **T1** | Env-asserted identity no longer works on the authenticated path | With `CLAD_MCP_AUTH=oauth`, start the server with `CLAD_AGENT_ID=admin`; connect a client holding a token bound to profile `analyst`; call a tool `admin` may use and `analyst` may not. | Denied. Audit row records **`analyst`**, not `admin`. Asserts WS3 §3's `resolvePrincipal` precedence — the env value is inert. |
| **T2** | No client-supplied id channel exists | Attempt to assert a profile via (a) a tool argument named `agent_id`, (b) an `agent_id` field in the `initialize` params, (c) a client-supplied `scope` on `/token`, (d) a `requestedProfileHint` at `/authorize`. | All four are ignored. (c) specifically: minted scope equals `mintScopesForProfile(policy, boundProfile)` regardless (WS2 §6 invariant). (d) hint may influence *display order* on the consent page but never the binding. |
| **T3** | Copied/replayed token rejected | **M3-gated.** Copy a DPoP-bound token to a second client without the private key; replay it. Separately, replay a consumed authorization code. | Bound token as plain Bearer ⇒ 401 (WS2 §8 downgrade rule). Consumed auth code ⇒ rejected (WS5 §7 single-use). **See §4 for the qualified verdict on bearer-only clients.** |
| **T4** | Revocation is immediate | Establish a working grant; revoke via the desktop UI; issue the next tool call. | 401 on the very next request, no restart, no cache (WS4 §4.2 — `verifyAccessToken` is a live store lookup). |
| **T5** | Real provider unreachable without a token | Start with `CLAD_PROVIDER=simplefin` on (a) stdio, (b) http without auth, (c) http+auth but no `Authorization` header. | (a),(b) refuse to boot; (c) 401 before any provider call. WS3 §5's two-layer gate. |

### Group B — No plaintext financial data out-of-band (D5.1) — *joint check*

| ID | Check | Procedure | Pass condition |
| --- | --- | --- | --- |
| **T6** | Cache unreadable out-of-band | With accounts/transactions cached, `strings`/`grep` the raw `*.sqlite` bytes for a known account name, balance figure, and merchant string from the fixture data. | Zero hits. Mirrors the "no plaintext at rest" assertion style already used in `token-store.test.ts` and specified for the grant store (WS5 §7). |
| **T7** | Grant store adds no new plaintext surface | Same byte-grep against `grants.sqlite` for a raw access token, refresh token, client secret, and authorization code. | Zero hits — tokens are stored **hashed**, not merely encrypted (WS5 §3), so this holds even against key compromise. |

### Group C — Shaping holds against a direct cache read (D5.1 + D5.2) — *the interlock check*

| ID | Check | Procedure | Pass condition |
| --- | --- | --- | --- |
| **T8** | Shaping is enforced at emission, not assumed of the agent | For a profile with `amount_visibility_cap` / `description_visibility: false` / merchant truncation: (a) call the tool as that profile and record the payload; (b) decrypt the cache in-process and compare against the raw rows. | The tool payload is strictly narrower than the cache contents. Raw fields never appear in tool output (`desktop-app.md:110`, `:143`). **This is the check that proves D5.2's shaping isn't bypassable by an authenticated-but-scoped agent.** |
| **T9** | The three-way interlock | Combine: an authenticated agent bound to a *restricted* profile attempts to reach unshaped data by (i) asserting another profile (T1/T2), (ii) reading the cache directly (T6), (iii) requesting a field its profile caps (T8). | All three paths closed. **This is the literal D5.4 requirement** — "a gap in any one undermines the other two". Record explicitly that all three were exercised *in the same build*. |

---

## 4. Expected qualified result on T3 (write this down honestly)

Parent §10 already establishes, and this plan must not paper over: **DPoP is not in the MCP auth spec and no mainstream client ships it.** Therefore at M3:

- T3's *server-side* half passes: a DPoP-bound token replayed without the key is rejected, and the downgrade path is closed (WS2 §8).
- T3's *ecosystem* half cannot pass for a bearer-only client — a copied bearer token **is** usable by whoever holds it, by construction. That is true of every OAuth resource server in the ecosystem today.

**The honest verdict to record:** `T3 — copied/replayed token rejected: PARTIAL (server-side enforced; unreachable for bearer-only clients until ecosystem DPoP support lands).` Plus the compensating controls that make this acceptable locally: loopback-only binding, the same-OS-user threat model, short token TTLs with refresh rotation (WS5 §8), and immediate revocation (T4). Do not record this as a pass. Parent §10 pre-committed to this framing; the note should cite it.

---

## 5. Automation vs. manual

| Check | Automated | Manual / recorded |
| --- | --- | --- |
| T1, T2, T5 | Integration tests (WS3 §8 `auth-enforcement.test.ts`, WS2 §9 `oauth-flow.test.ts`) | — |
| T3 | Unit + integration (WS2 §9 `dpop.test.ts`) | The ecosystem qualification (§4) is a written judgement |
| T4 | Cross-process integration (WS4 §6) | E2E with real Claude Desktop |
| T6, T7 | Byte-grep assertions in unit tests (WS5 §7 style) | Re-run against a **packaged, unsigned** build — S0 found build-mode-dependent behaviour (`desktop-app.md:67`) |
| T8, T9 | Integration once D5.2 lands | The interlock narrative is the note's core |

**Build-mode matrix** (from the S0 precedent): run T6/T7 and the E2E half of T4 in all three of `electron-vite dev`, `electron .` against built `out/`, and `electron-builder --dir` packaged-unsigned. The Keychain/safeStorage behaviour differs across these (WS5 §5, `passphrase.ts:44-62`), so a pass in dev alone is not a pass.

---

## 6. Out of scope for D5.4 (name them so they aren't assumed covered)

- **D6.3 path-separation** (`desktop-app.md:131`) — that the full-export path is disjoint from the scoped agent path is a *separate* verification with its own acceptance. D5.4 does not cover it; note the boundary so a reader doesn't infer coverage.
- **Root / different-OS-user attackers** — outside the stated model (§3).
- **Supply-chain integrity of `mcp-remote`** — it is a pinned dependency invoked by absolute path (`claude-desktop-config.ts:26-33`), which bounds but does not eliminate the risk. Worth a line in the note's "residual risks", not a check.
- **Network exposure** — the server binds loopback only (invariant 1, SEQUENCING §4); a check that it is *not* reachable off-host is cheap and worth adding to T5 as a sub-case, but the broader network posture isn't D5.4's question.

---

## 7. Note structure (the actual deliverable)

```
## D5.4 — Threat-model verification results

Build(s) exercised: <dev / out / packaged-unsigned>, <commit>
Preconditions: D5.1 <status>, D5.2 <status>, D5.3 <milestone>

T1 — profile spoofing via env:            BLOCKED
T2 — client-supplied identity channels:   BLOCKED (4 vectors tested)
T3 — copied/replayed token:               PARTIAL — see qualification
T4 — revocation immediacy:                CONFIRMED
T5 — real provider without token:         BLOCKED
T6 — plaintext financial data at rest:    NONE FOUND
T7 — plaintext OAuth material at rest:    NONE FOUND
T8 — shaping vs. direct cache read:       HOLDS
T9 — three-way interlock:                 CLOSED

### Qualifications
T3: <the §4 text, citing parent §10>

### Findings not asked for
<the S0-style section — the most valuable part>

### Residual risks
<mcp-remote supply chain; bearer-only ecosystem; cross-process SQLite contention>
```

Verdict vocabulary is deliberately narrow (`BLOCKED` / `CONFIRMED` / `PARTIAL` / `NONE FOUND` / `HOLDS` / `CLOSED`) so the table is scannable and a `PARTIAL` cannot hide as prose.
