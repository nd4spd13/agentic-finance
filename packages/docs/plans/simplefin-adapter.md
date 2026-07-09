# Implementation plan: SimpleFIN Bridge adapter

> **Status:** ready to execute · **Horizon:** H0 (see [roadmap](../roadmap.md))
> **For agents:** self-contained; read fully before starting. The protocol facts below were captured from simplefin.org on 2026-07-08 — **task SF1 includes re-verifying them against the live docs before coding.** Respect roadmap principles P1/P2/P4. When Linear tickets exist, branch as `{ISSUE_ID}/{kebab-case-title}`.

## Why SimpleFIN

SimpleFIN Bridge (https://beta-bridge.simplefin.org) gives users read-only access to their own bank data for $1.50/mo or $15/yr, paid by the user directly. No developer account, no company API keys, no linking widget: the user links banks on the Bridge's site and pastes a setup token into Clad. Data flows directly device ↔ Bridge — Clad-the-company is never in the path (roadmap P1) and nothing secret ships in the binary (P2). It is the low-friction option for users unwilling to create a Plaid developer account. Precedent: Actual Budget's SimpleFIN sync.

## Protocol reference (verified in SF1)

> Re-verified 2026-07-08 against the live `simplefin.org/protocol.html` spec and
> `beta-bridge.simplefin.org/info/developers` guide, plus three real
> `/accounts` responses from the public demo Bridge. Raw (scrubbed) captures
> live in `packages/simplefin-adapter/test/fixtures/` — see that directory's
> `README.md` for full capture provenance. Corrections from the original draft
> are called out inline; a **Discrepancies found in SF1** subsection below
> covers anything the original draft got wrong or omitted.

**Linking flow:**
1. User visits the Bridge, subscribes, links institutions, and generates a **setup token** (also available: a demo setup token on https://beta-bridge.simplefin.org/info/developers — fetch it fresh; do not trust any token copied into docs). Confirmed: the developers page embeds a server-rendered, ready-to-use demo token in a `<pre class="code">` block and states "refresh this page to generate another one" — i.e. each page load mints a fresh one-time token. The full "create a real token" flow is at `https://bridge.simplefin.org/simplefin/create` (no `beta-` prefix — this is the production Bridge; `beta-bridge.simplefin.org` is specifically the demo/sandbox host used for the developer guide and its demo token).
2. Setup token is a **base64-encoded claim URL**. Decode it. Confirmed verbatim: decodes to `https://beta-bridge.simplefin.org/simplefin/claim/DEMO-v2-<opaque-id>` for demo tokens.
3. `POST` to the claim URL with `Content-Length: 0` and an empty body. This is **one-time**: it consumes the token and returns an **access URL** in the response body. Confirmed: claiming a demo token during SF1 returned HTTP 200 with a bare access-URL string as the body (no JSON wrapper).
4. The access URL has embedded basic-auth credentials: `https://user:pass@host/path`. **The access URL is the credential.** Store it with the same care as a Plaid access token; never log it. Confirmed structurally in SF1 (host observed: `beta-bridge.simplefin.org`, path `/simplefin`); the credential itself was never written to any committed file or log — see the fixtures README for how this was verified.

**Data fetch:**
- `GET {accessUrl}/accounts?version=2` with query params:
  - `start-date`, `end-date` — Unix epoch seconds; window max 90 days per request. Confirmed by the developers guide ("limited to 90 days at a time").
  - `pending=1` — include pending transactions (excluded by default). Confirmed in docs; **not empirically observed** — none of the demo Bridge's transactions (across 3 SF1 captures, 136 total in the widest window) had `pending: true`, so the shape of a pending transaction is documented-only, not fixture-backed.
  - `account={id}` — repeatable filter. Documented; not exercised in SF1 (would have cost an extra request against the daily quota for no new information).
  - `balances-only=1` — balances without transactions. Confirmed, **with a correction**: it does not omit `transactions`/`holdings` from each account — it returns them as empty arrays. Do not use key-presence to detect balances-only responses.
- Response (`AccountSet`): **confirmed `errlist` is the current (v2) key** — every SF1 capture returned `"errlist": []`, never `"errors"`. `errors` was *not* seen in any real response, but the developers guide's own "Limits" prose still says rate-limit warnings appear in `"the errors array"` (contradicting its own "Errors" section two paragraphs above, which correctly says `errlist`) — treat that as stale wording in the guide, not a second real response shape, but **still defensively support both key names when parsing** since the guide itself is inconsistent. `connections[]` **is always present** in v2 (not "possibly" — it appeared, non-empty, in all 3 captures) and is a sibling of `accounts[]`, not nested inside it. `x-api-message` (string array) is a fourth top-level key, undocumented in either doc, seen once (only on the request with no `start-date`): `["Provide a 'start-date' parameter to receive transactions prior to yesterday"]` — an informational hint, safe to ignore but worth surfacing in debug logs.
  - Account: `id`, `name`, `currency` (ISO 4217 confirmed via `"USD"` in all captures; **the custom-currency-URL case was not observed** and remains unconfirmed live), `balance` and `available-balance` (**numeric strings**, confirmed — do not parse to float; use a decimal-safe representation), `balance-date` (epoch seconds, confirmed), **`conn_id` only — `org` does not exist in v2**. There is no per-account `org` field at all; organization identity is joined via `accounts[].conn_id` → `connections[].conn_id`, and the `Connection` object carries `conn_id`, `name`, `org_id`, `org_name`, `org_url`, `sfin_url` (the guide's spec text only mentioned `conn_id`/`name`/`org_id`/`org_url`/`sfin_url`; `org_name` was an additional field observed live). optional `transactions[]` (confirmed), optional `extra` (not observed — the demo Bridge does not appear to set it). **New, undocumented in the original draft:** accounts also carry a `holdings[]` array (investment holdings — `id`, `created`, `cost_basis`, `currency`, `description`, `market_value`, `purchase_price`, `shares`, `symbol`), present (possibly empty) on every account.
  - Transaction: `id`, `posted` (epoch seconds), `amount` (numeric string, signed — confirmed, e.g. `"-45.50"`), `description`, optional `transacted_at` (confirmed), `pending` (documented, not observed — see above), optional `extra` (not observed). **New, undocumented in the original draft:** transactions also carry `payee` and `memo` string fields on every observed transaction. Also note: on the demo Bridge, `id` is literally the `posted` epoch timestamp restated as a string — an implementation detail of this server, not a protocol guarantee, but worth knowing when writing fixture-driven tests (don't assume transaction ids are opaque/non-numeric).
- Errors: structured codes with prefixes `gen.` / `con.` / `act.` (e.g. `con.auth`); treat unknown subcodes as their prefix category; **sanitize error messages before display**. HTTP: `200` ok, `402` payment required (subscription lapsed), `403` auth failed or token compromised (confirmed by both docs; not exercised live in SF1 — doing so would have required deliberately breaking the one usable demo token, which would have burned the capture opportunity for no fixture value beyond what the docs already state).
- **Rate limits (design-critical):** confirmed **"24 requests or fewer per day"** per the developers guide, described as a soft cap ("a little leeway above this limit ... helpful when doing initial setup"), with **separate quotas for all-accounts (`GET /accounts`) vs single-account (`GET /accounts?account=...`) queries**, replenished throughout the day rather than reset once at midnight. Exceeding the expected rate limits surfaces warnings (guide's own text calls this the `errors` array, but see the `errlist`-vs-`errors` note above — assume it actually means `errlist`); sustained abuse disables the Access Token. SF1 made exactly 3 `/accounts` requests total and saw no warnings (`errlist` stayed empty throughout). Data refreshes ~daily upstream anyway (MX), so polling more than a few times a day buys nothing.

### Discrepancies found in SF1

1. **`errors` vs `errlist`:** live is `errlist` in every real response; `errors` never appeared as a response key, but the developers guide itself uses both names in different sections (see above) — parsing code should still tolerate `errors` defensively even though it wasn't observed, per the guide's own inconsistency.
2. **`org` vs `conn_id`:** confirmed v1/v2 split as suspected — v2 accounts have no `org` field at all, only `conn_id`, resolved against a top-level `connections[]` array. Design any adapter code exclusively around `conn_id` + `connections[]`; do not special-case a v1 `org` shape unless a future task needs v1 compatibility (out of scope here — SF1 only exercised v2).
3. **Undocumented `holdings[]` on accounts** (investment holdings, present — often empty — on every account) and **undocumented `x-api-message` top-level key** (informational hints) were observed live but appear nowhere in either the protocol spec page or the developers guide text. `mapping.ts` (SF4) should decide whether to surface or ignore `holdings`; recommend ignoring for the initial adapter (out of scope: Clad's core models are cash-account-oriented) but not erroring on its presence.
4. **Undocumented `payee`/`memo` transaction fields:** present on every observed transaction alongside `description`. Worth considering for `mapping.ts` (e.g. richer transaction descriptions) even though the plan's original scope only mentions `description`.
5. **`balances-only=1` semantics correction:** returns `transactions: []` and `holdings: []` rather than omitting the keys — confirmed by direct capture (`accounts-v2-balances-only.json`).
6. **Rate limits:** no numeric confirmation possible beyond "no warnings after 3 requests" (SF1 deliberately stayed far under quota); the "24/day, separate quotas per query type, replenished through the day" description is doc-only, not independently verified against actual throttling behavior.
7. **`pending` transactions:** never observed in the demo dataset despite requesting `pending=1` over a 35-day window (136 transactions checked, 0 pending) — the field's real-world shape remains unconfirmed by fixtures; `mapping.ts`/`client.ts` tests should not assume a `pending`-fixture exists and may need a hand-constructed case.
8. **Custom-currency-URL case:** documented (`currency` "ISO 4217 or a custom-currency URL") but not observed; demo Bridge only ever returned `"USD"`.
9. **Production vs demo host naming:** the real "generate a token" entry point is `https://bridge.simplefin.org/simplefin/create` (no `beta-` prefix); `beta-bridge.simplefin.org` is the demo/sandbox host referenced by the developers guide and used for SF1's captures. Adapter code/docs should not assume `beta-bridge.simplefin.org` is the production host for real user setup tokens.

## Design

New workspace package `packages/simplefin-adapter` (`@clad/simplefin-adapter`), mirroring `packages/plaid-adapter`'s structure and conventions (ESM, vitest, same tsconfig/eslint, `redactSecrets` from `@clad/core` on any string derived from stored data):

| File | Responsibility |
|---|---|
| `src/claim.ts` | Decode setup token, one-time claim POST → access URL. Pure; injectable `fetch` for tests. |
| `src/client.ts` | `GET /accounts` with params; basic auth parsed from access URL; response validation; error-code mapping. Never places the access URL (or its userinfo) in errors/logs. |
| `src/mapping.ts` | SimpleFIN account/transaction → `@clad/core` models (follow `plaid-adapter/src/mapping.ts` conventions: sign of amounts, pending flag, account ids namespaced `simplefin:{id}`). Amounts: keep the numeric-string → minor-units/decimal convention used by core; **no floats**. |
| `src/cache.ts` | Quota guardrail: persist last-fetch timestamp + response per item; enforce a minimum refresh interval (default: 6h, configurable); serve cached data otherwise. Follow `plaid-adapter/src/cache.ts` patterns. |
| `src/token-store.ts` usage | Reuse `SqliteTokenStore` from `@clad/plaid-adapter` if its item model is provider-agnostic (verify `StoredItemInput`); otherwise extract the store to `@clad/core` or a shared package first — prefer reuse over duplication. Store the access URL as the "token". |
| `src/errors.ts` | `SimpleFinError` hierarchy mapped from `gen./con./act.` codes + HTTP 402/403 semantics, messages pre-sanitized. |
| `src/adapter.ts` | Implements the same provider interface `plaid-adapter/src/adapter.ts` implements, so the MCP server's provider factory can construct it. |

Wiring beyond the package:
- `packages/mcp-server/src/provider-factory.ts`: add `simplefin` provider selection (env/config driven, mirroring how Plaid is selected today).
- `packages/cli/src/commands/connect.ts`: `clad connect --provider simplefin` → prompt to open the Bridge create page, paste setup token (readline, hidden input not required — it's one-time), claim, store access URL, print masked institution/account summary only.
- Desktop app: "Add connection → SimpleFIN" paste-token screen (tracked in desktop plan D3.2).

## Tasks

- **SF1 — Verify protocol + capture fixtures.** Fetch the live developer guide and protocol page; reconcile v1/v2 differences (`errors` vs `errlist`, `org` vs `connections`/`conn_id`); obtain the demo setup token from the developers page; claim it; capture real `/accounts` responses as fixtures in `packages/simplefin-adapter/test/fixtures/` (scrub any real-looking identifiers). Update the Protocol reference section above with corrections. *Acceptance: fixtures committed; protocol section updated; discrepancies documented.*
- **SF2 — Scaffold package + claim flow.** Package skeleton mirroring plaid-adapter; implement `claim.ts` with unit tests (base64 decode, POST semantics, one-time failure handling, malformed-token errors). *Acceptance: `pnpm --filter @clad/simplefin-adapter test` green; no network in unit tests.*
- **SF3 — Client + response parsing.** `client.ts` + `errors.ts` against SF1 fixtures: param building (90-day window enforcement), both error-array namings, error-code hierarchy, 402/403 mapping, access-URL redaction test (assert no userinfo appears in any thrown message). *Acceptance: tests cover happy path + each error class; redaction test present.*
- **SF4 — Mapping + cache.** `mapping.ts` with fixture-driven tests (numeric-string amounts, pending, currency URL case) and `cache.ts` with quota-guardrail tests (fetch suppressed within min interval; stale-served-with-timestamp). *Acceptance: mapped output typechecks against `@clad/core` models; cache behavior unit-tested with fake clock.*
- **SF5 — Storage + provider factory.** Token-store reuse decision implemented (see Design); `adapter.ts` conforming to the provider interface; `provider-factory.ts` wiring + tests (mirror `packages/mcp-server/test/provider-factory.test.ts`). *Acceptance: MCP server starts with `simplefin` provider configured and serves balances/transactions tools from fixtures/sandbox data.*
- **SF6 — CLI connect flow.** `clad connect --provider simplefin` per Design; never print the access URL; masked summary output. *Acceptance: end-to-end against the demo token: connect → `clad status` shows the item → MCP tool returns demo accounts.*
- **SF7 — Integration test + docs.** Network-gated integration test against the demo Bridge (pattern: `plaid-adapter/test/integration/sandbox.integration.test.ts`, run via a `test:integration` script, skipped by default); user-facing docs page (`packages/docs/integration-guides.md` addition or new page): what SimpleFIN is, costs, setup walkthrough, rate-limit expectations ("data refreshes ~daily"). *Acceptance: integration suite passes when run explicitly; docs build passes.*

Dependencies: SF1 → SF2/SF3/SF4 (fixtures) → SF5 → SF6 → SF7. SF2 can start in parallel with SF1 (claim flow is fixture-independent).

## Security invariants (every SF PR)

1. The access URL is a credential: encrypted at rest via the token store, file perms `0600`, never logged, never in error messages (assert via tests, as `token-store.ts` does).
2. All user-visible errors pass through sanitization; unknown error subcodes degrade to their prefix category.
3. No floats for money anywhere in the mapping path.
4. The cache must fail *closed* on quota: when in doubt, serve stale and surface staleness, don't burn requests.
