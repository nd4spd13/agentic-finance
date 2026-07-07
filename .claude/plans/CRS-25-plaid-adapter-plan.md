# CRS-25 Development Plan — Plaid Integration (adapter layer, account connection, data retrieval)

Linear: https://linear.app/crspy-inc/issue/CRS-25/plaid-integration-adapter-layer-account-connection-data-retrieval
Branch: `CRS-25/plaid-integration-adapter-layer` (convention: `{ISSUE_ID}/{kebab-case-title}`)
Commits: `feat(CRS-25): ...` / `test(CRS-25): ...` / `docs(CRS-25): ...`

## How to use this document

Each Work Package (WP) below is a self-contained brief for one sub-agent. Paste the
**Shared context** section plus one WP section into the sub-agent prompt. Model
assignments: **Opus** for security-critical and integration-heavy work (crypto, OAuth
flow), **Sonnet** for well-specified mechanical work (types, mapping, tests, docs).
Execute in the wave order given in "Execution order" — WPs in the same wave can run in
parallel (use separate worktrees or sequential commits on the feature branch).

---

## Shared context (include in every sub-agent prompt)

**Repo:** `/Users/csb/Documents/GitHub/agentic-finance` — pnpm monorepo ("Clad"), a
local-first policy/audit layer that exposes financial data to AI agents over MCP.

**Packages:**
- `packages/core` (`@clad/core`) — types, policy engine, `AuditLogger` (hash-chained,
  SQLite via `node:sqlite` `DatabaseSync`), `ApprovalQueue`, `DummyDataProvider`.
- `packages/mcp-server` — MCP stdio server; composition root. Currently hard-codes
  `new DummyDataProvider()` at `packages/mcp-server/src/server.ts:47`. Tools receive a
  `ToolContext` (`packages/mcp-server/src/types.ts`) containing `provider: DataProvider`.
- `packages/cli` — `clad` CLI; config at `~/.clad/config.json` via
  `packages/cli/src/config.ts` (`CLAD_CONFIG_DIR` overrides dir). `clad serve` spawns the
  mcp-server with env vars (`packages/cli/src/commands/serve.ts`).
- `packages/docs` — VitePress docs.

**Existing provider contract** (`packages/core/src/types/data-provider.types.ts`):
`DataProvider` with `getAccounts(userId)`, `getTransactions(userId, accountId, opts?)`,
`getBalance(userId, accountId)`, optional `getRecurringCharges(userId, accountId)`.
Types: `Account`, `Transaction`, `Balance`, `TransactionQueryOpts`, `RecurringCharge`.

**Conventions (CONTRIBUTING.md):** Node 22+, ESM-only with explicit `.js` import
extensions, strict TypeScript (no `any`), named exports only, Vitest, TDD (tests first).
`pnpm install && pnpm build && pnpm test` from repo root must pass before finishing.

**Amount sign convention (critical):** In `@clad/core` / `DummyDataProvider`, negative
amounts are money OUT (spending), positive is money IN (income). Plaid's API is the
opposite (positive = outflow). The Plaid adapter must negate Plaid amounts.

**Compliance requirements (from CRS-25, non-negotiable):**
1. Plaid access tokens encrypted at rest (AES-256-GCM), never plaintext on disk.
2. Access tokens never logged — all log/error paths must redact.
3. Access tokens never reachable from MCP clients — the token store must NOT be added
   to `ToolContext`; tools only ever see the `FinancialDataProvider` interface.
4. All data stays local: the only outbound network calls are to the Plaid API.

**Status of blockers:** CRS-23 (scaffolding) is done. CRS-43 (compliance review) gates
*production* Plaid access only — all work here targets **Plaid Sandbox**
(`PLAID_ENV=sandbox`); DummyDataProvider remains the default provider until CRS-43 clears.

---

## Architecture decisions (already made — do not re-litigate)

1. **New package** `packages/plaid-adapter` (`@clad/plaid-adapter`), depending on
   `@clad/core` and the official `plaid` npm SDK. `@clad/core` stays free of Plaid
   dependencies.
2. **Interface naming:** rename `DataProvider` → `FinancialDataProvider` in core, keep
   `export type DataProvider = FinancialDataProvider` as a deprecated alias so existing
   code keeps compiling. (The Linear AC names `FinancialDataProvider`.)
3. **Provider selection:** `provider: 'dummy' | 'plaid'` field in `CladConfig` +
   `CLAD_PROVIDER` env var (env wins). The mcp-server composition root uses a factory
   with a *dynamic import* of `@clad/plaid-adapter` so the Plaid SDK is only loaded when
   selected.
4. **Storage:** one SQLite DB `~/.clad/plaid.sqlite` (path in config as `plaid_db`,
   env `CLAD_PLAID_DB`), using `node:sqlite` `DatabaseSync` like `AuditLogger`. Tables:
   `meta` (KDF salt/params, key-check), `items` (encrypted access tokens), `cursors`
   (transactions/sync cursor per item), `accounts_cache`, `transactions_cache`.
   Token columns store `ciphertext`, `iv`, `auth_tag` — never plaintext.
5. **Key derivation:** AES-256-GCM key = `scrypt(passphrase, salt, 32)`. Passphrase from
   `CLAD_TOKEN_PASSPHRASE` env (server mode) or interactive prompt (`clad connect`).
   Random 16-byte salt generated once, stored in `meta`. A key-check record (encrypt a
   known constant) detects wrong passphrases without exposing tokens. OS keychain
   integration is deferred (note in docs).
6. **Link flow (desktop CLI, no app UI):** `clad connect` creates a `link_token`, starts
   an ephemeral HTTP server bound to `127.0.0.1` on a random port, serves a minimal HTML
   page that loads Plaid Link JS from Plaid's CDN with that token, opens the system
   browser, receives `public_token` via POST from the page's `onSuccess`, exchanges it
   for an `access_token`, encrypts and stores it. `--sandbox-auto` flag bypasses the
   browser using `/sandbox/public_token/create` (also used by CI/integration tests).
7. **Sync-then-read:** `PlaidAdapter.getTransactions` refreshes the local cache via
   `/transactions/sync` (cursor pagination), then answers queries from the cache. If
   Plaid is unreachable, answer from cache with `stale: true`; if no cache exists,
   throw `ProviderUnavailableError`.
8. **Stale flag:** add optional `stale?: boolean` to `Account`, `Transaction`, and
   `Balance` in core (absent = fresh). `DummyDataProvider` never sets it. Minimal,
   non-breaking.
9. **Plaid credentials** (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`) come from env
   vars only in V1 — never written to `config.json`. Document in `.env` style.
10. **Testability:** `PlaidAdapter` takes constructor injection:
    `new PlaidAdapter({ client, tokenStore, dbPath, userId? })` where `client` is the
    Plaid SDK API surface behind a thin `PlaidClientLike` interface, so unit tests use a
    fake client and never hit the network.

---

## Work packages

### WP1 — Core interface alignment & error types — **Sonnet**

**Depends on:** nothing. **Package:** `@clad/core`.

- Rename `DataProvider` → `FinancialDataProvider` in
  `packages/core/src/types/data-provider.types.ts`; add
  `/** @deprecated use FinancialDataProvider */ export type DataProvider = FinancialDataProvider`.
- Update `DummyDataProvider` and `packages/mcp-server/src/types.ts` to use the new name.
- Add `stale?: boolean` to `Account`, `Transaction`, `Balance`.
- Add `packages/core/src/types/provider-errors.ts`: classes
  `ProviderUnavailableError` (Plaid unreachable, no cache),
  `ProviderAuthError` (item login required / token revoked — carries `item_id`, never
  the token), both extending `Error` with a `code` string. Export from core index.
- Add `packages/core/src/security/redact.ts`: `redactSecrets(input: string): string`
  replacing Plaid token patterns
  (`access-(sandbox|development|production)-[A-Za-z0-9-]+`, `public-...`, `link-...`,
  and `secret`-like JSON fields) with `[REDACTED]`. Export from core index.
- Tests: type-level compile checks, redaction unit tests (token in plain string, in
  JSON.stringify'd error, in nested axios-style error message).

**Done when:** `pnpm build && pnpm test` green; no remaining references to the old name
outside the alias.

### WP2 — Package scaffold + provider selection plumbing — **Sonnet**

**Depends on:** WP1 (merge first; trivial rebase if parallel).

- Create `packages/plaid-adapter` mirroring `packages/core` layout: `package.json`
  (`@clad/plaid-adapter`, deps: `@clad/core` workspace, `plaid` latest), `tsconfig.json`
  extending `tsconfig.base.json`, `vitest.config.ts`, `src/index.ts`, `test/`.
- Define **interfaces only** (implementations come in WP3/WP5) so later WPs can build in
  parallel:
  - `src/token-store.types.ts`: `TokenStore` interface —
    `saveItem(item: { itemId, institutionName, accessToken }): void`,
    `getAccessToken(itemId): string`, `listItems(): StoredItemMeta[]` (no tokens),
    `deleteItem(itemId): void`, `close(): void`.
  - `src/plaid-client.types.ts`: `PlaidClientLike` — the minimal subset of the Plaid
    SDK used (`linkTokenCreate`, `itemPublicTokenExchange`, `accountsGet`,
    `accountsBalanceGet`, `transactionsSync`, `transactionsRecurringGet`,
    `sandboxPublicTokenCreate`), typed from the `plaid` package's request/response types.
  - `src/adapter.ts`: `PlaidAdapter implements FinancialDataProvider` — class skeleton
    with constructor injection per decision #10; methods throw `NotImplemented` for now.
- Config plumbing:
  - `packages/cli/src/config.ts`: add `provider: 'dummy' | 'plaid'` (default `'dummy'`)
    and `plaid_db` (default `~/.clad/plaid.sqlite`) to `CladConfig` + load/save handling.
  - `packages/cli/src/commands/serve.ts`: pass `CLAD_PROVIDER` and `CLAD_PLAID_DB` env.
  - `packages/mcp-server/src/server.ts`: replace the hard-coded `DummyDataProvider` with
    a `createProvider()` factory: reads `CLAD_PROVIDER` (default `dummy`); `plaid` branch
    dynamic-imports `@clad/plaid-adapter`, fails fast with a clear stderr message if
    `PLAID_CLIENT_ID`/`PLAID_SECRET`/`CLAD_TOKEN_PASSPHRASE` are missing. Add
    `@clad/plaid-adapter` to mcp-server deps.
  - **Compliance guard:** `ToolContext` must NOT gain a token-store field. Add a test
    asserting `ToolContext` keys are exactly the current five.
- Tests: config round-trip with new fields; factory returns Dummy by default; factory
  errors cleanly when plaid selected without credentials.

**Done when:** workspace builds; `pnpm test` green; `CLAD_PROVIDER=dummy` behavior is
byte-for-byte unchanged.

### WP3 — Encrypted token store — **Opus** (security-critical)

**Depends on:** WP2 (uses its `TokenStore` interface). **Package:** `@clad/plaid-adapter`.

- `src/crypto.ts`: `deriveKey(passphrase, salt)` (scrypt, N=2^15, r=8, p=1, keylen 32 —
  document params), `encrypt(key, plaintext) -> { ciphertext, iv, authTag }` (AES-256-GCM,
  12-byte random IV), `decrypt(key, payload)`. Pure functions over `node:crypto`.
- `src/token-store.ts`: `SqliteTokenStore implements TokenStore` on
  `node:sqlite` `DatabaseSync` (mirror `AuditLogger`'s style,
  `packages/core/src/audit/logger.ts`). Creates `meta` + `items` tables (decision #4).
  On first open: generate salt, write key-check. On subsequent opens: verify key-check,
  throw `TokenStoreKeyError` (message must not include passphrase or derived key) on
  mismatch. `listItems()` returns metadata only — no token material in the return type.
- Redaction discipline: no method may put token plaintext into an Error message,
  console output, or thrown object. Run all outbound strings through `redactSecrets`
  from `@clad/core` defensively.
- Tests (write first): encrypt/decrypt round-trip; tampered ciphertext/auth-tag rejects
  (GCM integrity); wrong passphrase → `TokenStoreKeyError`; DB file on disk contains no
  token substring (write token `access-sandbox-abc...`, read raw file bytes, assert
  absent); `listItems` never returns tokens; salt persists across reopen.

**Done when:** tests green; a grep of the package for `console.log` shows no token-adjacent
logging; file permissions on the DB set to `0600` at creation.

### WP4 — Plaid Link connect flow + `clad connect` — **Opus** (hardest integration)

**Depends on:** WP2, WP3. **Packages:** `@clad/plaid-adapter`, `@clad/cli`.

- `src/link.ts` in plaid-adapter:
  - `createLinkToken(client, opts)` → `/link/token/create` (products: `transactions`,
    country `US`, language `en`, client_name "Clad").
  - `runLinkFlow({ client, tokenStore, openBrowser?, timeoutMs = 5 min })`:
    1. Start `node:http` server on `127.0.0.1:0` (ephemeral port).
    2. `GET /` serves inline HTML loading
       `https://cdn.plaid.com/link/v2/stable/link-initialize.js`, initializes
       `Plaid.create({ token, onSuccess, onExit })`; `onSuccess` POSTs
       `{ public_token, metadata }` to `/callback`; `onExit` POSTs error to `/exit`.
    3. Open system browser (darwin `open`, linux `xdg-open`, win32 `start`) — injectable
       `openBrowser` for tests.
    4. On `/callback`: exchange via `/item/public_token/exchange`, save through
       `TokenStore`, respond with a "you can close this tab" page, resolve with
       `{ itemId, institutionName, accounts }` (NO token in the return value).
    5. Timeout / `onExit` → reject with typed error; always close the server.
  - `runSandboxAutoFlow({ client, tokenStore, institutionId = 'ins_109508' })`: uses
    `/sandbox/public_token/create` → exchange → store. No browser. Refuse to run unless
    `PLAID_ENV=sandbox`.
- `packages/cli/src/commands/connect.ts`: `clad connect [--sandbox-auto]` — validates
  env credentials, prompts for passphrase if `CLAD_TOKEN_PASSPHRASE` unset (hidden input
  via `node:readline`), runs the flow, prints institution + masked account list. On
  success, offer hint text to set `provider: 'plaid'` (or set it automatically with
  `--use`). Register in `packages/cli/src/index.ts`.
- Security details: callback server binds 127.0.0.1 only; single-use random path
  segment in callback URL to prevent other local processes posting to it; server stops
  listening immediately after success; tokens never printed or logged (redact any Plaid
  SDK error before display — axios errors can embed request headers containing
  `PLAID_SECRET`).
- Tests (fake `PlaidClientLike` + injected `openBrowser` that drives the HTTP endpoints
  directly): success path stores encrypted token and resolves metadata; exit path
  rejects; timeout path rejects and frees the port; sandbox-auto path; assertion that
  resolved objects and error messages contain no `access-` token substring.

**Done when:** unit tests green; manual smoke: `PLAID_ENV=sandbox clad connect
--sandbox-auto` stores an item end-to-end against real sandbox (documented in the PR,
requires sandbox keys).

### WP5 — Data retrieval, sync, cache, graceful degradation — **Sonnet**

**Depends on:** WP2 (interfaces); runs in parallel with WP3/WP4 using an in-memory fake
`TokenStore`. **Package:** `@clad/plaid-adapter`.

- Implement `PlaidAdapter` methods (`src/adapter.ts`) + `src/cache.ts` (tables
  `accounts_cache`, `transactions_cache`, `cursors` in the same `plaid.sqlite`):
  - `getAccounts`: `/accounts/get` per stored item → map to core `Account`
    (Plaid `type/subtype` → core union: depository/checking→`checking`,
    depository/savings→`savings`, credit→`credit`, loan→`loan`, investment/brokerage→
    `investment`; unknown → nearest with `subtype` preserved). Upsert cache. On network
    failure: serve cache with `stale: true`, else `ProviderUnavailableError`.
  - `getBalance`: `/accounts/balances/get` → `Balance` (`last_updated` = now). Same
    degradation rule (cached balance from `accounts_cache` + `stale: true`).
  - `getTransactions`: run `syncTransactions(itemId)` first —
    `/transactions/sync` loop while `has_more`, persist added/modified, delete removed,
    save cursor per item; on `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restart from
    last *saved* cursor. Then answer from cache applying `TransactionQueryOpts`
    (`start_date`/`end_date` inclusive, `count` limit, sorted date desc — match
    DummyDataProvider filter semantics). Mapping: `amount: -plaid.amount` (sign
    convention!), `date: authorized_date ?? date`, `description: name`,
    `merchant_name`, `category: personal_finance_category` primary+detailed lowercased,
    `pending`. On sync failure: serve cache with `stale: true` on each row.
  - `getRecurringCharges`: `/transactions/recurring/get` outflow streams →
    `RecurringCharge` (`amount: average_amount`, frequency map: WEEKLY→`weekly`,
    BIWEEKLY→`biweekly`, SEMI_MONTHLY→`biweekly` (closest), MONTHLY→`monthly`,
    ANNUALLY→`annually`; `next_date: predicted_next_date`; confidence: map Plaid
    `is_active` + stream status → high/medium/low as specced in code comments;
    `source: 'provider'`).
  - `ItemLoginRequiredError` from Plaid (`ITEM_LOGIN_REQUIRED`) → `ProviderAuthError`.
- Multi-item: methods aggregate across all stored items; `accountId` args route to the
  owning item via `accounts_cache`.
- Tests (fake `PlaidClientLike` with canned fixtures; add fixtures under
  `packages/plaid-adapter/test/fixtures/`): each mapping rule above gets an explicit
  assertion (especially amount negation and type mapping); sync pagination across 3
  pages; mutation-during-pagination retry; removed-transaction handling; degradation:
  client throws → cached data with `stale: true`; empty cache → `ProviderUnavailableError`;
  interchangeability test: run the same call sequence against `DummyDataProvider` and
  `PlaidAdapter` (faked) and assert both satisfy `FinancialDataProvider` typing and
  return-shape invariants.

**Done when:** all unit tests green without network access.

### WP6 — Logging/audit redaction hardening — **Sonnet**

**Depends on:** WP1. Runs any time after it; touches `mcp-server` + `core`.

- `packages/mcp-server/src/server.ts`: the catch path logs `String(error)` into the
  audit trail (`server.ts:81`) — wrap with `redactSecrets(...)`. Same for the success
  path's `JSON.stringify(args)` (defense in depth) and every `process.stderr.write` that
  can carry an error.
- Audit the plaid-adapter (post-WP3/4/5) and CLI `connect` output paths for any
  `console.*`/`stderr` writes of error objects; route through `redactSecrets`.
- Tests: end-to-end style unit test — invoke the mcp-server tool handler wrapper with a
  provider that throws an error whose message embeds a fake
  `access-sandbox-...` token; assert the audit DB row and stderr contain `[REDACTED]`
  and not the token.

**Done when:** grep for `String(error)` / `JSON.stringify` in logging paths shows all
wrapped; tests green.

### WP7 — Sandbox integration tests + docs — **Sonnet**

**Depends on:** WP3, WP4, WP5, WP6 (final wave).

- `packages/plaid-adapter/test/integration/sandbox.integration.test.ts`, gated:
  `describe.runIf(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && process.env.PLAID_ENV === 'sandbox')`
  so `pnpm test` stays green without credentials. Flow: `runSandboxAutoFlow` → temp-dir
  DB (`CLAD_CONFIG_DIR` to tmp) → `getAccounts`, `getBalance`, `getTransactions` (assert
  pagination completes, amounts negative for outflows), `getRecurringCharges` → raw DB
  file contains no token bytes. Add `test:integration` script.
- Docs:
  - `packages/docs/integration-guides.md`: "Connecting a bank via Plaid (sandbox)" —
    env vars, `clad connect`, passphrase model, switching `provider`, stale-data
    semantics, what never leaves the device.
  - `packages/docs/architecture.md`: provider abstraction diagram note
    (FinancialDataProvider ← DummyDataProvider | PlaidAdapter; future MX/Finicity).
  - README one-liner + `CONTRIBUTING.md` project-structure tree gains `plaid-adapter/`.
- Final pass: verify every Linear acceptance criterion below and check it off in the PR
  description.

**Done when:** integration suite passes against live sandbox locally; docs build
(`packages/docs` VitePress) succeeds.

---

## Execution order

| Wave | WPs (parallel within wave) | Models |
|------|---------------------------|--------|
| 1 | WP1 | Sonnet |
| 2 | WP2 | Sonnet |
| 3 | WP3 (crypto/token store) ∥ WP5 (data/sync/cache) ∥ WP6 (redaction) | Opus ∥ Sonnet ∥ Sonnet |
| 4 | WP4 (Link flow + CLI) | Opus |
| 5 | WP7 (sandbox integration + docs) | Sonnet |

WP1→WP2 are small and sequential (WP2 builds on the rename). Wave 3 is the big parallel
wave: WP3 and WP5 only share the `TokenStore`/`PlaidClientLike` interfaces frozen in WP2.

## Acceptance criteria traceability (from CRS-25)

| Linear AC | Covered by |
|---|---|
| PlaidAdapter implements FinancialDataProvider | WP1, WP2, WP5 |
| Plaid Link OAuth flow works | WP4 |
| Tokens encrypted at rest (AES-256-GCM) | WP3 |
| Tokens never logged | WP1 (redact util), WP3, WP4, WP6 |
| Tokens never exposed to MCP clients | WP2 (ToolContext guard test), WP3 (`listItems` shape) |
| Typed Account retrieval | WP5 |
| Transaction sync pagination | WP5 |
| Recurring charge detection | WP5 |
| Graceful degradation w/ stale flag | WP1 (types), WP5 |
| Dummy ↔ Plaid interchangeable at runtime | WP2 (factory), WP5 (interchangeability test) |
| Plaid Sandbox integration test | WP7 |
| Fully local data flow | Architecture (no new outbound calls except Plaid); WP7 docs |

## Out of scope for CRS-25

- Production Plaid access (gated on CRS-43 compliance review).
- MX/Finicity adapters (V1.5) — the interface work here is the enabler.
- OS keychain key storage (documented as deferred).
- Webhooks (local-first CLI has no public endpoint; sync is pull-based).
- Changes to policy engine, approval queue, or MCP tool schemas (CRS-26 owns tools).
