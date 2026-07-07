# CRS-25 — Plaid Integration: Acceptance Criteria Checklist

Compiled at the end of WP7 (final wave). Status reflects the state of the
`CRS-25/wp7-integration-docs` worktree after WP1–WP7.

## Legend

- [x] Done and covered by automated tests
- [~] Partially done / done with a known gap (see notes)
- [ ] Not done

---

- [x] **PlaidAdapter implements `FinancialDataProvider`**
  - Implemented: `packages/plaid-adapter/src/adapter.ts` (`export class PlaidAdapter implements FinancialDataProvider`)
  - Tested: `packages/plaid-adapter/test/adapter.test.ts`, `test/adapter-data.test.ts`, `test/types/adapter.types.test.ts`, `test/interchangeability.test.ts`
  - Status: Done.

- [~] **Plaid Link OAuth flow works**
  - Implemented: `packages/plaid-adapter/src/link.ts` (`createLinkToken`, `runLinkFlow` — interactive browser flow via a loopback-only callback server, `runSandboxAutoFlow` — non-interactive sandbox flow); `packages/cli/src/commands/connect.ts` (`clad connect [--sandbox-auto] [--use]`)
  - Tested: `packages/plaid-adapter/test/link.test.ts` (unit, faked Plaid client + real HTTP loopback server); `packages/plaid-adapter/test/integration/sandbox.integration.test.ts` (`runSandboxAutoFlow` against the real Plaid sandbox API)
  - Status: Flow logic is implemented and unit-tested. `connectCommand` itself (the thin CLI wrapper in `packages/cli/src/commands/connect.ts`) has **no automated test** — `packages/cli/test/cli.test.ts` does not cover it, and `packages/cli` is not included in `vitest.workspace.ts` at all. **The WP4 manual smoke test (running `clad connect` and `clad connect --sandbox-auto` end to end from a terminal) is pending** — not yet executed in this environment (no Plaid sandbox credentials available here; see integration guide).

- [x] **Tokens encrypted at rest (AES-256-GCM)**
  - Implemented: `packages/plaid-adapter/src/crypto.ts` (`deriveKey`/`encrypt`/`decrypt`, scrypt KDF); `packages/plaid-adapter/src/token-store.ts` (`SqliteTokenStore`, chmod 0600, key-check record)
  - Tested: `test/crypto.test.ts`, `test/token-store.test.ts` (asserts raw DB file bytes never contain the plaintext token, in both latin1 and utf8), `test/link.test.ts`, `test/integration/sandbox.integration.test.ts` (same raw-bytes assertion against a real sandbox-issued token)
  - Status: Done.

- [x] **Tokens never logged**
  - Implemented: no `console.*` calls anywhere in `token-store.ts`; `redactSecrets` (`@clad/core`) applied defensively in `errors.ts` (`LinkFlowError`), `adapter.ts` (`describeError`), `link.ts` (`toLinkFlowError`, `summarizeExit`); mcp-server-side redaction of audit log / stderr / client errors (WP6, `packages/mcp-server/src`)
  - Tested: `test/token-store.test.ts`, `test/link.test.ts` (assert thrown error messages never contain `access-`), `packages/mcp-server/test/redaction.test.ts`
  - Status: Done.

- [x] **Tokens never exposed to MCP clients**
  - Implemented: `TokenStore.listItems()` returns `StoredItemMeta` only — no token field (`packages/plaid-adapter/src/token-store.types.ts`); `PlaidAdapter`'s `Account`/`Balance`/`Transaction`/`RecurringCharge` return shapes carry no token material; `LinkFlowResult` (`link.ts`) deliberately excludes the access token from its return value
  - Tested: `test/token-store.test.ts`, `test/link.test.ts`, `test/adapter-data.test.ts`, `test/interchangeability.test.ts` (all assert on return shapes)
  - Status: Done — structural guarantee: the MCP tool layer only ever sees `FinancialDataProvider` return types, which have no token field by construction.

- [x] **Typed Account retrieval**
  - Implemented: `adapter.ts` `getAccounts()`; `mapping.ts` `mapAccount()` / `mapAccountType()`
  - Tested: `test/adapter-data.test.ts`, `test/mapping.test.ts`, `test/interchangeability.test.ts`, `test/integration/sandbox.integration.test.ts`
  - Status: Done.

- [x] **Transaction sync pagination**
  - Implemented: `adapter.ts` `runSyncLoop()` / `syncTransactionsForItem()` — `/transactions/sync` cursor pagination looping on `has_more`, cursor persisted after every page, restarts from the call-start cursor on `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`; `cache.ts` (`cursors` table)
  - Tested: `test/adapter-data.test.ts` (multi-page sync, mutation-during-pagination restart), `test/cache.test.ts`, `test/integration/sandbox.integration.test.ts` (real pagination against sandbox, with `PRODUCT_NOT_READY` retry and an assertion that mapped outflow amounts are negative per the core sign convention)
  - Status: Done.

- [x] **Recurring charge detection**
  - Implemented: `adapter.ts` `getRecurringCharges()`; `mapping.ts` `mapRecurringCharge()` / `mapRecurringConfidence()`
  - Tested: `test/adapter-data.test.ts`, `test/mapping.test.ts`, `test/interchangeability.test.ts`, `test/integration/sandbox.integration.test.ts` (shape-only — sandbox data may legitimately return zero streams)
  - Status: Done.

- [x] **Graceful degradation with `stale` flag**
  - Implemented: `adapter.ts` `degradeToAccountsCache()` / `degradeToBalanceCache()` / stale-mapping in `getTransactions()`; `stale?: boolean` on `Account`/`Balance`/`Transaction` (`@clad/core`); `ProviderUnavailableError` thrown when no cache exists to degrade to; `ProviderAuthError` thrown immediately (never degraded) on `ITEM_LOGIN_REQUIRED`
  - Tested: `test/adapter-data.test.ts` (stale-serving on failure, `ProviderUnavailableError` with empty cache, `ProviderAuthError` short-circuits degradation)
  - Status: Done.

- [~] **Dummy ↔ Plaid interchangeable at runtime**
  - Implemented (interface level): `DummyDataProvider` (`@clad/core`) and `PlaidAdapter` (`@clad/plaid-adapter`) both implement `FinancialDataProvider`; `packages/mcp-server/src/provider-factory.ts` selects between them via `CLAD_PROVIDER`
  - Tested: `packages/plaid-adapter/test/interchangeability.test.ts` (identical call sequence run against both providers, asserting the same shape invariants); `packages/mcp-server/test/provider-factory.test.ts` (env-var selection + missing-credential validation)
  - Status: **Gap** — `createPlaidProvider()` in `provider-factory.ts` validates that `PLAID_CLIENT_ID` / `PLAID_SECRET` / `CLAD_TOKEN_PASSPHRASE` are present but does **not** construct a live `PlaidAdapter`; it still throws a placeholder `"not yet implemented"` error (`provider-factory.ts:55-58`), and this is pinned down by an existing test (`provider-factory.test.ts`: *"fails with a not-yet-implemented error when plaid credentials are all present"*). `CLAD_PLAID_DB` is plumbed through by `clad serve` (`packages/cli/src/commands/serve.ts:36`) but never consumed anywhere. **`@clad/plaid-adapter` itself is fully interchangeable with `DummyDataProvider` at the interface level** (proven by tests above) — what's missing is the final boot-time wiring inside the MCP server so `CLAD_PROVIDER=plaid` actually constructs a working `PlaidAdapter` when you run `clad serve`. This wiring was out of scope for WP7 (docs + sandbox test + this checklist) and should be picked up as a small follow-up before `provider: 'plaid'` is usable end-to-end.

- [x] **Plaid Sandbox integration test**
  - Implemented: `packages/plaid-adapter/test/integration/sandbox.integration.test.ts` (this work package) — runs `runSandboxAutoFlow` against the real Plaid sandbox API, then `getAccounts` / `getBalance` / `getTransactions` (with `PRODUCT_NOT_READY` retry and a negative-outflow assertion) / `getRecurringCharges` through a real `PlaidAdapter`, and asserts the token-store DB file never contains a plaintext `access-` token.
  - Status: **Implemented, requires a local run with sandbox keys.** Gated with `describe.runIf(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && process.env.PLAID_ENV === 'sandbox')` so `pnpm test` reports it **skipped** (not failed) without credentials — confirmed in this environment (no sandbox credentials available here). Run it via:
    ```bash
    PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox \
      pnpm --filter @clad/plaid-adapter test:integration
    # or from the repo root:
    PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox pnpm test:integration
    ```

- [x] **Fully local data flow**
  - Implemented: policy engine, audit log, approval queue, and encrypted token store are all local SQLite/file-backed (`@clad/core`, `@clad/plaid-adapter`); the only outbound network calls anywhere in the stack are to the Plaid API, made exclusively through the narrow `PlaidClientLike` interface (`adapter.ts`, `link.ts`)
  - Tested: `test/integration/sandbox.integration.test.ts` asserts the token DB never contains plaintext token material after real outbound calls; no test independently asserts "zero non-Plaid network calls" (would require a network-call allowlist/proxy, judged out of scope)
  - Status: Done by design and consistent with the narrow `PlaidClientLike` surface used throughout.

---

## Summary

| Status | Count |
|---|---|
| Done | 9 |
| Partial / known gap | 3 |
| Not done | 0 |

**Known gaps carried forward (not fixed in WP7, per its scope):**

1. **mcp-server runtime wiring for `CLAD_PROVIDER=plaid`** (`packages/mcp-server/src/provider-factory.ts`) — currently a stub that validates credentials and then throws `"not yet implemented"`; needs to construct a real `SqliteTokenStore` + `PlaidApi` client + `PlaidAdapter` using `CLAD_PLAID_DB`/`CLAD_TOKEN_PASSPHRASE`/`PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV`, and the existing "not yet implemented" test in `provider-factory.test.ts` will need to be replaced with real construction tests.
2. **WP4 manual smoke test** (`clad connect` / `clad connect --sandbox-auto` run by hand end to end) — pending; not executed in this environment (no sandbox credentials).
3. **`@clad/cli` is not part of `vitest.workspace.ts`** — `packages/cli/test/cli.test.ts` exists and is nontrivial (config, log, approvals, escalation, policy commands) but is not exercised by the root `pnpm test`. Pre-existing, unrelated to CRS-25 specifically, but worth a follow-up ticket since it means `connectCommand` (and everything else in `@clad/cli`) has no CI coverage today.

None of the above block WP7's deliverables (sandbox integration test, docs, this checklist), but all three should be tracked as immediate follow-ups before Plaid is considered production-ready end to end.
