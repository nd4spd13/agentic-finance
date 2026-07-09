# Implementation plan: SimpleFIN Bridge adapter

> **Status:** ready to execute · **Horizon:** H0 (see [roadmap](../roadmap.md))
> **For agents:** self-contained; read fully before starting. The protocol facts below were captured from simplefin.org on 2026-07-08 — **task SF1 includes re-verifying them against the live docs before coding.** Respect roadmap principles P1/P2/P4. When Linear tickets exist, branch as `{ISSUE_ID}/{kebab-case-title}`.

## Why SimpleFIN

SimpleFIN Bridge (https://beta-bridge.simplefin.org) gives users read-only access to their own bank data for $1.50/mo or $15/yr, paid by the user directly. No developer account, no company API keys, no linking widget: the user links banks on the Bridge's site and pastes a setup token into Clad. Data flows directly device ↔ Bridge — Clad-the-company is never in the path (roadmap P1) and nothing secret ships in the binary (P2). It is the low-friction option for users unwilling to create a Plaid developer account. Precedent: Actual Budget's SimpleFIN sync.

## Protocol reference (verify in SF1)

**Linking flow:**
1. User visits the Bridge, subscribes, links institutions, and generates a **setup token** (also available: a demo setup token on https://beta-bridge.simplefin.org/info/developers — fetch it fresh; do not trust any token copied into docs).
2. Setup token is a **base64-encoded claim URL**. Decode it.
3. `POST` to the claim URL with `Content-Length: 0` and an empty body. This is **one-time**: it consumes the token and returns an **access URL** in the response body.
4. The access URL has embedded basic-auth credentials: `https://user:pass@host/path`. **The access URL is the credential.** Store it with the same care as a Plaid access token; never log it.

**Data fetch:**
- `GET {accessUrl}/accounts?version=2` with query params:
  - `start-date`, `end-date` — Unix epoch seconds; window max 90 days per request
  - `pending=1` — include pending transactions (excluded by default)
  - `account={id}` — repeatable filter
  - `balances-only=1` — balances without transactions
- Response (`AccountSet`): `errors`/`errlist` (naming differs between docs versions — handle both), possibly `connections` (v2), and `accounts[]`:
  - Account: `id`, `name`, `currency` (ISO 4217 **or a custom-currency URL**), `balance` and `available-balance` (**numeric strings** — do not parse to float; use a decimal-safe representation), `balance-date` (epoch seconds), `org`/`conn_id` (v1 vs v2 differ — verify), optional `transactions[]`, optional `extra`
  - Transaction: `id`, `posted` (epoch seconds), `amount` (numeric string, signed), `description`, optional `transacted_at`, `pending`, `extra`
- Errors: structured codes with prefixes `gen.` / `con.` / `act.` (e.g. `con.auth`); treat unknown subcodes as their prefix category; **sanitize error messages before display**. HTTP: `200` ok, `402` payment required (subscription lapsed), `403` auth failed or token compromised.
- **Rate limits (design-critical):** on the order of **24 requests per day**, with separate quotas for all-accounts vs single-account queries. Exceeding limits surfaces warnings in the errors array; sustained abuse disables the token. Data refreshes ~daily upstream anyway (MX), so polling more than a few times a day buys nothing.

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
