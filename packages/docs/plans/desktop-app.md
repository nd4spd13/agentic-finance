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

_S0.2: … · S0.3: … · S0.4: … · Go/no-go: …_

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
