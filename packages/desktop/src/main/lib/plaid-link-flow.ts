/**
 * D3.1 — Plaid Link in-app connect flow.
 *
 * Ports `connect.ts`'s Plaid path into the desktop app by *reusing*
 * `@clad/plaid-adapter`'s `runLinkFlow`/`runSandboxAutoFlow` as-is — no fork
 * of the loopback server or the HTML page it serves (`link.ts`) was needed.
 * `runLinkFlow`'s public API already takes an injectable `openBrowser(url)`,
 * which is exactly the seam this module needs; everything below is a thin
 * wrapper adding the bits a one-shot CLI command doesn't need: a
 * renderer-facing progress state machine (pushed over the
 * `connect:plaidLinkStatusChanged` channel, same shape as
 * `McpServerManager`'s `onStatusChange` -> `mcp:statusChanged`), and a
 * cancel action.
 *
 * SYSTEM BROWSER, not a `BrowserWindow` (desktop-app.md D3.1 left this as an
 * implementation decision): many institutions bounce Plaid Link through
 * their own OAuth login domain before redirecting back, and the user's
 * regular browser already has that bank's session, saved password, and 2FA
 * set up — a `BrowserWindow` would have to either re-authenticate from
 * scratch or reimplement a chunk of what a real browser already does for
 * free. `shell.openExternal` (injected here as `openExternal`, real callers
 * pass Electron's `shell.openExternal` — see `main/index.ts`) hands the
 * whole thing off, matching the same choice `runLinkFlow`'s own default
 * `openBrowser` already makes for the CLI (see `link.ts`'s
 * `defaultOpenBrowser`); this module just routes the identical loopback URL
 * through Electron's API instead of spawning `open`/`xdg-open` directly, so
 * the security posture matches `createWindow`'s `setWindowOpenHandler` in
 * `main/index.ts` (security checklist item 4). `isExpectedPlaidLinkUrl`
 * below validates the URL before it ever reaches `openExternal`: `link.ts`
 * only ever constructs a `http://127.0.0.1:<port>/<pathId>` loopback URL
 * itself (never `https` — it isn't talking to a remote origin, just hosting
 * a local page that itself loads Plaid's own `https://cdn.plaid.com` script),
 * so this is a defensive check against `@clad/plaid-adapter` ever changing
 * that shape unexpectedly, not a check against attacker-controlled input.
 *
 * CANCEL / TEARDOWN: `runLinkFlow`'s public API (in `@clad/plaid-adapter`,
 * out of scope for this task to modify — only `packages/desktop` may change)
 * has no handle to force-close its internal loopback server mid-flight; it
 * only ever settles on success, `onExit`, or its own `timeoutMs` (default 5
 * minutes — see `link.ts`). `cancel()` below is therefore a UI-level
 * abandonment, not a socket-level one: it immediately flips the status this
 * module reports back to `'idle'` and discards the result of the
 * already-running `runLinkFlow` promise when it eventually settles (via the
 * `currentAttemptId` guard, same pattern `McpServerManager` uses for a
 * superseded spawn attempt). A late success is still a real, legitimately
 * completed connection — its token gets saved via `tokenStore.saveItem`
 * exactly as if the user hadn't clicked Cancel in this app — the desktop UI
 * just isn't watching for it anymore; the next time the user opens Connect,
 * `getPlaidLinkStatus`/the token store itself reflects it. Two real
 * teardown paths exist and both are exercised: (1) the flow's own
 * `timeoutMs` closes its server after 5 minutes even with no cancel at all;
 * (2) `main/index.ts`'s `before-quit` handler calls `app.exit(0)`
 * unconditionally, which ends the loopback server along with the entire
 * process on quit, regardless of what this module is doing.
 */

import { getCladPlaidAdapter } from './plaid-adapter.js'
import { getCladCore } from './clad-core.js'
import { effectivePlaidDbPath, type CladConfig } from './config.js'

export type PlaidLinkFlowState = 'idle' | 'pending' | 'success' | 'error'

/** Display-safe summary of one linked account — never a token. */
export interface PlaidLinkedAccountSummary {
  id: string
  name: string
  mask?: string
}

export interface PlaidLinkFlowStatus {
  state: PlaidLinkFlowState
  institutionName?: string
  itemId?: string
  accounts?: PlaidLinkedAccountSummary[]
  /** Display-safe (redacted where derived from a thrown Plaid/link error). */
  error?: string
}

export interface StartPlaidLinkFlowOptions {
  /** Dev-flag-gated sandbox auto-connect (no browser) — see `connect.ts`'s `--sandbox-auto`. */
  sandboxAuto?: boolean
}

export interface PlaidLinkFlowDeps {
  loadConfig: () => CladConfig
  /** Null when Plaid credentials haven't been saved yet. */
  loadPlaidCredentials: () => { clientId: string; secret: string } | null
  /** Null when passphrase custody isn't resolved yet (e.g. CLI-migration prompt still pending). */
  getActivePassphrase: () => string | null
  /** Opens a URL in the user's default browser. Real callers pass Electron's `shell.openExternal`; injected so tests never spawn a real browser. */
  openExternal: (url: string) => void | Promise<void>
  onStatusChange: (status: PlaidLinkFlowStatus) => void
  /**
   * Whether sandbox-auto is allowed to run at all in this build — real
   * callers pass `() => !app.isPackaged`. This module deliberately takes no
   * `electron` import (same DI-for-testability rule as every other file
   * under `main/lib/**`), so the actual dev/packaged check lives in
   * `main/index.ts` and is injected here.
   */
  isDevBuild: () => boolean
  /**
   * Test-only seam: builds the Plaid API client used for the flow. Real
   * callers omit this — it defaults to `createPlaidClient` (from
   * `@clad/plaid-adapter`, via `getCladPlaidAdapter()`) below. Tests inject a
   * fake `PlaidClientLike` here instead, the same way `@clad/plaid-adapter`'s
   * own `link.test.ts` does, so no test in this suite ever touches the real
   * Plaid network.
   */
  createClient?: (
    creds: { clientId: string; secret: string },
    plaidEnv: CladConfig['plaid_env']
  ) => import('@clad/plaid-adapter').PlaidClientLike
  /** Test-only seam: overrides `runLinkFlow`'s default 5-minute browser-flow timeout so a "never completes" test doesn't have to wait for it. Real callers omit this. */
  timeoutMs?: number
}

/**
 * Defensive check before handing a URL to `openExternal` (security checklist
 * item 4). See the module doc comment above for why this is `http://127.0.0.1`
 * (or `localhost`), not `https` — the loopback page itself, not a remote
 * origin.
 */
export function isExpectedPlaidLinkUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
}

/**
 * `'unavailable'` when the token-store passphrase isn't resolved yet — same
 * gate `missingPlaidPrereqs` (`provider-factory.ts`) uses. Distinct from
 * `'not-connected'`, which means the passphrase works fine but no Plaid item
 * has been saved yet. Used by the D3.2 Connect screen's "connected/not
 * connected" status — deliberately does not build new listing
 * infrastructure: `SqliteTokenStore.listItems()` already exists for exactly
 * this.
 */
export async function getPlaidConnectionState(deps: {
  loadConfig: () => CladConfig
  getActivePassphrase: () => string | null
}): Promise<'connected' | 'not-connected' | 'unavailable'> {
  const passphrase = deps.getActivePassphrase()
  if (!passphrase) return 'unavailable'

  const config = deps.loadConfig()
  const { SqliteTokenStore } = await getCladPlaidAdapter()

  let store: InstanceType<typeof SqliteTokenStore> | undefined
  try {
    // D3.3: env-scoped path — see `effectivePlaidDbPath`'s doc comment
    // (config.ts). A sandbox connection is invisible here when `config`
    // reports `plaid_env: 'production'` (and vice versa) by design: they're
    // different physical SQLite files.
    store = new SqliteTokenStore({ dbPath: effectivePlaidDbPath(config, config.plaid_env), passphrase })
    return store.listItems().length > 0 ? 'connected' : 'not-connected'
  } catch {
    return 'unavailable'
  } finally {
    store?.close()
  }
}

export class PlaidLinkFlowManager {
  private status: PlaidLinkFlowStatus = { state: 'idle' }
  /**
   * Bumped on every `start()`/`cancel()` call; a `runLinkFlow` promise whose
   * captured attempt id no longer matches is discarded instead of clobbering
   * newer state — same pattern as `McpServerManager.currentAttemptId`.
   */
  private currentAttemptId = 0

  constructor(private readonly deps: PlaidLinkFlowDeps) {}

  getStatus(): PlaidLinkFlowStatus {
    return this.status
  }

  private setStatus(status: PlaidLinkFlowStatus): void {
    this.status = status
    this.deps.onStatusChange(status)
  }

  /**
   * Stops watching the current flow (if any) and clears a terminal
   * success/error status back to idle — see the module doc comment's
   * "CANCEL / TEARDOWN" section for what this does and does not tear down.
   */
  cancel(): PlaidLinkFlowStatus {
    this.currentAttemptId += 1
    this.setStatus({ state: 'idle' })
    return this.status
  }

  async start(opts: StartPlaidLinkFlowOptions = {}): Promise<PlaidLinkFlowStatus> {
    if (this.status.state === 'pending') {
      // Already running — the renderer should cancel first if it wants to
      // restart. Avoids two overlapping `runLinkFlow` calls (and loopback
      // servers) racing over the same token store.
      return this.status
    }

    this.currentAttemptId += 1
    const attemptId = this.currentAttemptId

    const config = this.deps.loadConfig()
    const creds = this.deps.loadPlaidCredentials()
    const passphrase = this.deps.getActivePassphrase()

    if (!creds || !passphrase) {
      return this.fail(
        'Plaid credentials and/or the token-store passphrase are not set up yet. Finish Settings first.'
      )
    }

    if (opts.sandboxAuto) {
      if (!this.deps.isDevBuild()) {
        return this.fail('Sandbox auto-connect is only available in development builds.')
      }
      if (config.plaid_env !== 'sandbox') {
        return this.fail('Sandbox auto-connect requires the Plaid environment to be set to Sandbox.')
      }
    }

    this.setStatus({ state: 'pending' })

    const { createPlaidClient, SqliteTokenStore, runLinkFlow, runSandboxAutoFlow } =
      await getCladPlaidAdapter()

    const client = this.deps.createClient
      ? this.deps.createClient(creds, config.plaid_env)
      : createPlaidClient({ clientId: creds.clientId, secret: creds.secret, env: config.plaid_env })

    let tokenStore: InstanceType<typeof SqliteTokenStore>
    try {
      // D3.3: env-scoped path — see `effectivePlaidDbPath`'s doc comment
      // (config.ts). A newly-linked Item lands in the ACTIVE env's file,
      // matching whatever `getPlaidConnectionState` above reports for the
      // same config.
      tokenStore = new SqliteTokenStore({ dbPath: effectivePlaidDbPath(config, config.plaid_env), passphrase })
    } catch (err) {
      const message = await this.describeError(err)
      if (attemptId !== this.currentAttemptId) return this.status
      return this.fail(message)
    }

    try {
      const result = opts.sandboxAuto
        ? await this.runSandboxAutoWithEnvBridge(runSandboxAutoFlow, client, tokenStore, config.plaid_env)
        : await runLinkFlow({
            client,
            tokenStore,
            timeoutMs: this.deps.timeoutMs,
            openBrowser: async (url) => {
              if (!isExpectedPlaidLinkUrl(url)) {
                throw new Error('Refusing to open an unexpected URL for Plaid Link.')
              }
              await this.deps.openExternal(url)
            },
          })

      if (attemptId !== this.currentAttemptId) {
        // Cancelled (or superseded by a newer start()) while this was in
        // flight — the token is already saved (a legitimate connection);
        // just don't clobber whatever status the cancel/newer call set.
        return this.status
      }

      const status: PlaidLinkFlowStatus = {
        state: 'success',
        institutionName: result.institutionName,
        itemId: result.itemId,
        accounts: result.accounts.map((account) => ({
          id: account.id,
          name: account.name,
          mask: account.mask,
        })),
      }
      this.setStatus(status)
      return status
    } catch (err) {
      const message = await this.describeError(err)
      if (attemptId !== this.currentAttemptId) return this.status
      return this.fail(message)
    } finally {
      tokenStore.close()
    }
  }

  private fail(error: string): PlaidLinkFlowStatus {
    const status: PlaidLinkFlowStatus = { state: 'error', error }
    this.setStatus(status)
    return status
  }

  /**
   * `runSandboxAutoFlow` (in `@clad/plaid-adapter`, out of scope for this
   * task to modify) has its own independent safety guard: it refuses to run
   * unless `process.env.PLAID_ENV === 'sandbox'` (see `link.ts`). That's a
   * real OS env var, not `config.plaid_env` — the desktop app has no shell
   * to set `PLAID_ENV` from (D1.1 keeps it in `config.json` instead), so
   * without this bridge the guard would always reject sandbox-auto in this
   * app even after `start()` above already validated `config.plaid_env ===
   * 'sandbox'`. Sets `process.env.PLAID_ENV` for the duration of exactly
   * this one call and restores whatever was there before (including
   * "unset") in a `finally`, so it never leaks into any other code path —
   * e.g. `mcp-server-env.ts`'s own `PLAID_ENV` handling for the spawned MCP
   * child, which is unrelated and must not see this temporary value.
   */
  private async runSandboxAutoWithEnvBridge(
    runSandboxAutoFlow: Awaited<ReturnType<typeof getCladPlaidAdapter>>['runSandboxAutoFlow'],
    client: Parameters<typeof runSandboxAutoFlow>[0]['client'],
    tokenStore: Parameters<typeof runSandboxAutoFlow>[0]['tokenStore'],
    plaidEnv: CladConfig['plaid_env']
  ): ReturnType<typeof runSandboxAutoFlow> {
    const previousPlaidEnv = process.env.PLAID_ENV
    process.env.PLAID_ENV = plaidEnv
    try {
      return await runSandboxAutoFlow({ client, tokenStore })
    } finally {
      if (previousPlaidEnv === undefined) {
        delete process.env.PLAID_ENV
      } else {
        process.env.PLAID_ENV = previousPlaidEnv
      }
    }
  }

  /**
   * Produces a user-facing error string. `LinkFlowError`/`TokenStoreKeyError`
   * messages are already secret-free by construction; everything else is
   * passed through `redactSecrets` defensively before display — same
   * discipline as `connect.ts`'s `describePlaidError`.
   */
  private async describeError(err: unknown): Promise<string> {
    const { LinkFlowError, TokenStoreKeyError } = await getCladPlaidAdapter()
    if (err instanceof LinkFlowError) return err.message
    if (err instanceof TokenStoreKeyError) return err.message
    const { redactSecrets } = await getCladCore()
    return redactSecrets(err instanceof Error ? err.message : String(err))
  }
}
