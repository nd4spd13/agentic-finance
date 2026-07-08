# Implementation plan: Clad desktop app

> **Status:** ready to execute · **Horizon:** H0 (see [roadmap](../roadmap.md))
> **For agents:** this document is self-contained. Read the whole thing before starting any task. Respect the roadmap's binding principles — especially P1/P2 (no secrets in the renderer or in binaries) and P4 (encrypted local storage). Every task lists acceptance criteria; do not mark a task done unless all criteria pass. When Linear tickets exist, branch as `{ISSUE_ID}/{kebab-case-title}`.

## Context an agent needs

Repo: pnpm monorepo, TypeScript, ESM (`"type": "module"` everywhere), vitest, eslint/prettier, `tsconfig.base.json` at root.

Existing packages (all reused, none rewritten):

| Package | What it provides to the desktop app |
|---|---|
| `@clad/core` | Policy engine (`parsePolicy`), approval queue (`packages/core/src/approval/queue.ts`, SQLite), audit logger (`packages/core/src/audit/logger.ts`, SQLite), `redactSecrets` |
| `@clad/plaid-adapter` | `SqliteTokenStore` (AES-256-GCM under scrypt-derived key, `node:sqlite`), `runLinkFlow`/`runSandboxAutoFlow`, Plaid client + mapping |
| `@clad/mcp-server` | MCP server entry `packages/mcp-server/dist/server.js` (stdio transport), provider factory reading env vars |
| `@clad/cli` | Reference implementations to port: `start.ts` (spawn server with config-derived env), `connect.ts` (Plaid Link flow via express + `open`), `ui.ts` (express-served React policy editor SPA in `packages/cli/static`), `config.ts` (config dir handling), plus `scripts/setup-mcp.js` at repo root (writes Claude Desktop MCP config) |

Key facts:

- The token store and audit/approval stores use `node:sqlite` (`DatabaseSync`). `node:sqlite` needs a recent Node; Electron bundles its own Node version — **whether it includes `node:sqlite` is spike question S0.2**. The CLI test suite already runs with a `node:sqlite` shim (see commit `47176a1`), so a swap seam exists.
- Plaid credentials come from env vars only (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`) and are never written to config files. The desktop app must preserve this: keep them in OS-keychain-backed storage, never in plaintext config.
- The token store takes a passphrase (`CLAD_TOKEN_PASSPHRASE` in server mode). The desktop app replaces "type a passphrase" with Electron `safeStorage` (Keychain/DPAPI-backed).

## Locked technical decisions

- **Electron** (not Tauri): the entire codebase is Node/TS; Electron's main process runs it unmodified.
- Scaffold: **electron-vite** + React 18 + TypeScript for the renderer; new workspace package `packages/desktop` (`@clad/desktop`, private).
- Packaging: **electron-builder** (DMG + ZIP for macOS; NSIS later for Windows), publishing to GitHub Releases.
- Process security model (non-negotiable):
  - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for the renderer.
  - All secret material (tokens, Plaid env, passphrase, SQLite handles) lives in the **main process only**.
  - Renderer ⇄ main via a typed IPC contract exposed through a preload `contextBridge` allowlist. Define the contract in one shared types file (`packages/desktop/src/shared/ipc.ts`); no `ipcRenderer.send` with arbitrary channels.
  - IPC responses carry display-safe data only — account metadata, masked numbers, policy JSON, approval items. Never an access token or the passphrase. Mirror the redaction discipline of `token-store.ts` (no secret ever interpolated into an error message or log).
- Windows portability from day one (publish later): all paths via `app.getPath(...)` + a per-platform lookup module for external paths (Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows). No hardcoded `~/Library` outside that module.

## Spike S0 (timebox: 2–3 days total)

Goal: answer the four questions that determine everything downstream. Produce `packages/desktop` in working-skeleton state and **write the answers back into this document** under "Spike results" below.

### S0.1 — Scaffold `packages/desktop`

Create the electron-vite scaffold as a pnpm workspace member; wire `pnpm --filter @clad/desktop dev` and `build`. Add to root workspace config if needed (`pnpm-workspace.yaml` already globs `packages/*`).

Acceptance: dev mode opens a window with hot reload; `electron-builder --dir` produces a launchable unpacked app on macOS; `pnpm -r build` still passes for all existing packages.

### S0.2 — `node:sqlite` in Electron's main process

In the main process, import `@clad/core` and `@clad/plaid-adapter` from the workspace, then construct `SqliteTokenStore` against a temp file with a test passphrase; write and read back one fake item. Record: Electron version, its bundled Node version, whether `node:sqlite` loads (and whether it needs a flag).

Acceptance: round-trip succeeds in dev **and** in the packaged app (ASAR changes module resolution — verify both). If `node:sqlite` is unavailable: implement the fallback decision — swap to `better-sqlite3` behind the same interface (the CLI test shim shows the seam) — and record the decision here. Deliverable either way: a one-paragraph "Spike results" entry.

### S0.3 — `safeStorage` passphrase custody

Flow to prove: first launch generates a random high-entropy token-store passphrase → `safeStorage.encryptString` → ciphertext to `app.getPath('userData')/passphrase.bin` → relaunch → decrypt → open token store without user interaction.

Acceptance: works across relaunch; document what the macOS Keychain prompt UX looks like (if any); confirm `safeStorage.isEncryptionAvailable()` is checked with a sane error path. Note for the future: this changes the trust model from "user-memorized passphrase" to "OS keychain + random secret" — capture any migration implications for existing CLI users in the results note.

### S0.4 — MCP server lifecycle from the app

From the main process, spawn `packages/mcp-server/dist/server.js` (port the resolution + env logic from `packages/cli/src/commands/start.ts`) and verify a real MCP handshake — use `@modelcontextprotocol/sdk` client over stdio, list tools, call one read-only tool. Kill/restart cleanly.

Acceptance: tools list matches the CLI-launched server; no stdout pollution breaks the protocol (see the warning in `serve.ts`); server child dies when the app quits (no orphans — verify with `ps`).

### Spike results (fill in at completion)

**S0.2 — `node:sqlite` in Electron's main process: GO, no fallback needed.** Electron 43.1.0 bundles Node **24.18.0**, which ships `node:sqlite` unflagged and stable (`process.versions.sqlite` reports `3.53.1`; no `--experimental-sqlite` flag required). A real `SqliteTokenStore` round trip (write one fake item, read it back, list it) succeeds in `electron-vite dev`, in `electron .` against the built `out/` tree, and in the fully packaged, unsigned `electron-builder --dir` app (verified by asserting the item content, not just "no throw"). The one real finding here wasn't `node:sqlite` — it was module format: `@clad/core` and `@clad/plaid-adapter` are ESM-only (`exports` map has no `require`/`default` condition), and electron-vite's default main-process output is CommonJS. A **static** `import` of either package gets rewritten by the bundler to a top-level `require()` that throws immediately at module load (`ERR_PACKAGE_PATH_NOT_EXPORTED`), crashing the main process on startup before any code runs — this is *not* limited to `@clad/plaid-adapter` (which `provider-factory.ts` already dynamic-imports for its own reasons); it applies equally to `@clad/core`, which the CLI/mcp-server never hit because their own build output is ESM. Fix: every `@clad/core`/`@clad/plaid-adapter` reference from `packages/desktop/src/main/**` goes through a dynamic `import()` (see `src/main/lib/clad-core.ts` and the `await import('@clad/plaid-adapter')` in `src/main/spike/node-sqlite-check.ts`) — confirmed by grepping the built `out/main/index.js` for zero eager `require("@clad/...")` calls. `@modelcontextprotocol/sdk` did not need this treatment; it ships a genuine dual CJS/ESM build (`require` condition present), so a static import resolves fine.

**S0.3 — `safeStorage` passphrase custody: GO, works exactly as designed.** First launch: `safeStorage.isEncryptionAvailable()` is checked (macOS Keychain-backed here, `true`); a random 32-byte passphrase is base64-encoded, sealed with `safeStorage.encryptString`, and written to `<userData>/passphrase.bin` at `0600` (mirroring `token-store.ts`'s file-mode discipline, re-applied on every open). Relaunch (both `electron .` on the dev build and the packaged `.app`, same `--user-data-dir` across two separate process launches) reports `source: "loaded"` and decrypts correctly with **zero prompts** — no visible Keychain access dialog appeared in either run, because `safeStorage` on macOS is backed by the login keychain, which is already unlocked for the logged-in user session (a Keychain "always allow" prompt is possible the *first* time a *newly signed* binary requests access under stricter conditions — e.g. after Gatekeeper/notarization enters the picture in H1 — so this should be re-checked once code signing lands; today's unsigned local build shows no prompt at all). Migration implication for existing CLI users: the CLI's model is a user-memorized `CLAD_TOKEN_PASSPHRASE` opening `~/.clad/plaid.sqlite`; the desktop app's model is a random, never-displayed passphrase in a **separate** safeStorage-encrypted file. These are not interchangeable — a user who already has a CLI-managed `~/.clad/plaid.sqlite` cannot have the desktop app silently take it over with a different passphrase. D1.1 (config/migration) needs an explicit one-time flow: detect an existing CLI-style store, prompt once for the CLI passphrase, re-encrypt under a new desktop-managed random passphrase (or reuse the same DB with the CLI passphrase wrapped by safeStorage instead of memorized) — this is a real D1 task, not a footnote.

**S0.4 — MCP server lifecycle from the app: GO, with one path-resolution deviation from the plan.** The main process spawns `@clad/mcp-server` and drives a real `@modelcontextprotocol/sdk` `Client` over `StdioClientTransport`: connect → `tools/list` → `tools/call clad_get_balances`. Tool list (`clad_get_balances`, `clad_get_transactions`, `clad_safe_to_spend`, `clad_request_action`, `clad_audit_log`) matches the CLI-launched server's tool set exactly (same array in `server.ts`), and the balances call returns real dummy-provider data. No stdout pollution: the server's existing stderr-only diagnostic discipline (`serve.ts`'s documented invariant) held up under a real JSON-RPC client, not just visual inspection. Verified in dev, in `electron .` against the build, and in the packaged app — where the spawned child's argv literally points *inside* `app.asar` (`.../Clad.app/Contents/Resources/app.asar/node_modules/@clad/mcp-server/dist/server.js`), confirming Electron's asar-transparent execution works for a script path handed to `child_process`. Clean shutdown confirmed by `ps`: sending `SIGTERM` to the Electron main process (both dev and packaged builds) runs the `before-quit` handler, which closes the MCP client/transport (the SDK's `close()` sends `SIGTERM` then `SIGKILL` after a 2s grace period) — zero orphaned `server.js` processes in every run. Two deliberate deviations from a literal port of `start.ts`/`serve.ts`, both load-bearing for a packaged app: (1) **path resolution** — the CLI's relative `../../../mcp-server/dist/server.js` walk assumes a fixed sibling-package layout that doesn't exist once packaged (only `@clad/desktop`'s own `out/` + `node_modules` land in `app.asar`); instead `@clad/mcp-server` is a normal `dependencies` entry, resolved via `createRequire(import.meta.url).resolve('@clad/mcp-server')`, and electron-builder's ordinary node_modules bundling carries the whole workspace-dependency graph (`@clad/core`, `@clad/plaid-adapter`, `@modelcontextprotocol/sdk`) along for free — confirmed via `asar list` on the packaged app. (2) **interpreter** — the child is spawned as `process.execPath` (the Electron binary) with `ELECTRON_RUN_AS_NODE=1`, not a system `node`, since a packaged app cannot assume the end user has Node installed at all. One dev-mode-only wrinkle worth flagging for tooling, not a security issue: killing `electron-vite dev`'s own CLI wrapper process does **not** cascade to the Electron app it spawned or that app's MCP child (they're left running); sending the signal to the actual Electron main process itself is what triggers the graceful shutdown path. Worth a `pnpm --filter @clad/desktop dev`-adjacent dev-docs note in D1.

**Go/no-go: GO for Phase D1.** All four spike acceptance criteria are met with no fallback required (`node:sqlite` just works; no `better-sqlite3` shim needed, simplifying D1 considerably versus the risk noted in the roadmap). The one real blocker-class risk this spike surfaced — static ESM imports of workspace packages silently crashing the CJS main bundle — is now understood and fixed at the root (`src/main/lib/clad-core.ts`), and should be called out explicitly in D1 code review: **any new main-process code that imports `@clad/core` or `@clad/plaid-adapter` must use dynamic `import()`, never a static import** (worth an eslint rule or at least a CLAUDE.md note before D1.1 starts, since it's an easy mistake with a bad failure mode — a silent crash on startup with no window ever shown). Two carry-forward items for D1: (a) the CLI-passphrase migration flow noted under S0.3, and (b) deciding whether `mcp-server`'s spawn env should keep using a temp per-launch policy/audit/approval set (as this spike does) versus the real `~/.clad/*` paths via a ported `config.ts` (D1.1's job). Nothing found here changes the locked technical decisions or the security checklist.

## Phase D1 — Shell (est. 1–2 weeks)

- **D1.1 Config + migration.** Port `packages/cli/src/config.ts` handling; read the same config dir the CLI uses so both stay interoperable. Settings UI: paths, Plaid env selection. Plaid `CLIENT_ID`/`SECRET` entered in settings are stored via `safeStorage`, never plaintext (P2/P4).
- **D1.2 MCP server lifecycle.** Productionize S0.4: start/stop/restart, crash detection with backoff, status surfaced to renderer. Server env assembled in main from safeStorage-held values.
- **D1.3 Tray/menu-bar presence.** Menu-bar icon (template image) with status (server running, pending approvals count), open-window, quit. Single-instance lock; closing the window keeps the app alive in the tray (configurable).
- **D1.4 "Connect to Claude Desktop" action.** Port `scripts/setup-mcp.js` into the app behind one button using the per-platform path module. Show diff/confirmation before writing another app's config file; handle Claude Desktop not installed.

Acceptance for the phase: fresh machine → download app → set Plaid keys (or skip) → click Connect to Claude Desktop → Claude Desktop lists clad tools — without touching a terminal.

## Phase D2 — Product UI (est. 2–4 weeks)

- **D2.1 Approvals inbox.** Wire `@clad/core` approval queue to a renderer inbox; native OS notification on new pending approval (click → focuses inbox item); approve/deny writes through the queue and is audit-logged. This is the flagship feature — polish it.
- **D2.2 Audit log viewer.** Paginated, filterable (agent, tool, decision, date), read-only view over the audit SQLite.
- **D2.3 Dashboard.** Balances + recent transactions via the adapter layer (works with whichever providers are connected). Respect provider rate limits — display cached data with a last-refreshed stamp (critical once SimpleFIN lands; see the SimpleFIN plan's caching rules).
- **D2.4 Policy editor.** Port the existing React SPA (`packages/cli/static` + `ui.ts` API routes) into the renderer; replace the HTTP API with IPC calls to main (`GET/PUT policy` → validated via `parsePolicy`, YAML written to disk as `ui.ts` does).

## Phase D3 — Connect flow in-app (est. ~1 week)

- **D3.1 Plaid Link in-app.** Port `connect.ts`'s flow: main process runs the loopback server (reuse `runLinkFlow`), Link opens in a `BrowserWindow` (or system browser — decide during implementation; system browser is simpler for OAuth-bank redirects). Store the token via the existing token store. Sandbox-auto flow behind a dev flag.
- **D3.2 Provider-agnostic connect UI.** One "Add connection" screen listing configured providers (Plaid BYO, SimpleFIN once SF lands). SimpleFIN path is paste-a-token (see SimpleFIN plan SF6).

## Phase D4 — Distribution (est. ~1 week for unsigned; signing adds a day once the Apple account exists)

- **D4.1 electron-builder config.** DMG + ZIP targets, app id, icons, `files` allowlist so workspace deps resolve in ASAR.
- **D4.2 Release workflow.** GitHub Actions: tag → build → draft GitHub Release with artifacts. macOS runner.
- **D4.3 Unsigned-beta docs.** README install section: download, Gatekeeper "Open Anyway" walkthrough (Sequoia removed right-click-open), `xattr -d com.apple.quarantine` alternative.
- **D4.4 (gated on Apple Developer enrollment) Signing + notarization.** Developer ID cert in CI secrets; hardened runtime + entitlements; notarize + staple; enable `electron-updater` (requires signed builds). Keep as a separate PR so unsigned releases keep working.

## Standing security checklist (apply to every desktop PR)

1. Renderer never receives tokens, passphrases, or Plaid credentials — grep the IPC contract types.
2. No new `console.*` in code paths that touch secret material; errors through `redactSecrets` where derived from stored data.
3. `contextIsolation`/`sandbox` flags unchanged; no `nodeIntegration`; no `webSecurity: false`; navigation locked to app pages (`will-navigate` handler).
4. External URLs open in the system browser (`shell.openExternal` allowlist), never in-app.
5. New files with secret material: `0600` perms, following `token-store.ts`.
