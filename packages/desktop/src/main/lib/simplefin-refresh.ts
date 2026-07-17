/**
 * User-initiated "Check for new accounts" for the desktop Connect screen
 * (`ConnectView.tsx`) — the manual escape hatch that complements
 * `@clad/simplefin-adapter`'s automatic setup-grace window.
 *
 * Why this exists (and why it is not just another dashboard refresh):
 * institutions are linked on the SimpleFIN Bridge's own website, which this
 * app never observes — there is no webhook or completion event to react to,
 * so a newly-linked bank only appears the next time the app happens to
 * refetch. The adapter's 6h interval is right for steady state but leaves a
 * just-linked user staring at a stale account set with no way to say "look
 * again now". `SimpleFinAdapter.forceRefresh()` is that signal; this module
 * exposes it to the renderer, and `getSimpleFinRefreshStatus` lets the UI
 * *explain* the cooldown/budget rather than leave a button that silently
 * no-ops (the exact failure mode that made a missing account undiagnosable).
 *
 * This is NOT a quota bypass. `forceRefresh` runs the same fail-closed
 * `SimpleFinCache.shouldRefresh` gate with a 1-minute floor and a rolling
 * daily budget — see the adapter for the guardrail rationale. Mashing the
 * button cannot spend a request per click, nor starve the app's own upkeep
 * fetches.
 *
 * Construct-use-dispose: unlike the dashboard's long-lived cached provider,
 * this builds a `SimpleFinAdapter` per IPC call against the same
 * `config.simplefin_db` file (token store + cache share it), then closes both
 * — matching `listSimpleFinItems`/`removeSimpleFinItem` in
 * `connection-management.ts`. Because the cache is that shared SQLite file, a
 * force refresh here updates exactly the rows the dashboard provider reads on
 * its next fetch; the IPC handler in `main/index.ts` invalidates the
 * dashboard snapshot afterward so the new accounts surface without an
 * unprompted network fetch from the dashboard layer.
 *
 * SECURITY (same hard rule as the rest of `src/main/**`): only display-safe
 * data crosses back to the renderer — item ids, counts, timings, and
 * secret-free error strings. The access URL is read only to hand to the
 * adapter's own fetch path; it is never returned, logged, or interpolated
 * into any string here. Every error is routed through the adapter's
 * secret-free `SimpleFinError` types or `redactSecrets` defensively.
 *
 * ESM/CJS: `@clad/core` and `@clad/simplefin-adapter` are ESM-only and would
 * crash this CJS main bundle on a static import — reached only through
 * `getCladCore()` / `getCladSimpleFinAdapter()` (enforced by the desktop
 * eslint override), with inline `import('@clad/...')` types.
 */

import { getCladCore } from './clad-core.js'
import { getCladSimpleFinAdapter } from './simplefin-adapter.js'
import type { CladConfig } from './config.js'

export interface SimpleFinRefreshDeps {
  loadConfig: () => CladConfig
  /** `null` when passphrase custody isn't resolved yet (e.g. CLI-migration prompt still pending). */
  getActivePassphrase: () => string | null
  /** Test-only seam forwarded to the adapter's fetch path; defaults to `globalThis.fetch`. Never set by real callers. */
  fetch?: typeof fetch
}

/** Display-safe outcome of a "Check for new accounts" click. Mirrors the adapter's `ForceRefreshResult` plus an `ok` flag for the IPC contract. */
export interface SimpleFinForceRefreshResult {
  ok: boolean
  /** Number of items that made a live request and updated their cache. */
  refreshedCount: number
  /** Number of items skipped because they fetched within the 1-minute floor. */
  skippedCount: number
  /** `true` when the rolling daily budget refused at least one item. */
  budgetExhausted: boolean
  /** Requests spent in the rolling 24h window, after this call. */
  requestsInLastDay: number
  /** Display-safe; set when the passphrase isn't resolved, or a fetch failed. */
  error?: string
}

/** Display-safe cooldown/budget status for the Connect screen. */
export interface SimpleFinRefreshStatus {
  /** `false` when the passphrase isn't resolved yet — the UI shows the same "unavailable" state it uses for the connection itself. */
  available: boolean
  /** Milliseconds until an automatic refresh is next allowed; `0` when one is due now. */
  msUntilRefreshAllowed: number
  /** `true` while at least one item is inside its post-setup grace window. */
  inSetupGrace: boolean
  /** Requests spent in the rolling 24h window. */
  requestsInLastDay: number
  /** Remaining force-refresh budget in the rolling 24h window. */
  forceRefreshBudgetRemaining: number
}

/**
 * Runs the adapter's user-initiated `forceRefresh` against the stored
 * SimpleFIN items. Never throws — every failure path returns
 * `{ ok: false, error }` so the IPC handler stays a plain pass-through,
 * mirroring `claimAndStoreSimpleFinToken`.
 */
export async function forceRefreshSimpleFin(
  deps: SimpleFinRefreshDeps
): Promise<SimpleFinForceRefreshResult> {
  const passphrase = deps.getActivePassphrase()
  if (!passphrase) {
    return {
      ok: false,
      refreshedCount: 0,
      skippedCount: 0,
      budgetExhausted: false,
      requestsInLastDay: 0,
      error: 'The token-store passphrase is not resolved yet — finish the migration/setup prompt first.',
    }
  }

  const config = deps.loadConfig()
  const adapter = await buildAdapter(config, passphrase, deps.fetch)
  if (!adapter) {
    return {
      ok: false,
      refreshedCount: 0,
      skippedCount: 0,
      budgetExhausted: false,
      requestsInLastDay: 0,
      error: 'Could not open the SimpleFIN token store.',
    }
  }

  try {
    const result = await adapter.instance.forceRefresh()
    return {
      ok: true,
      refreshedCount: result.refreshed.length,
      skippedCount: result.skipped.length,
      budgetExhausted: result.budgetExhausted,
      requestsInLastDay: result.requestsInLastDay,
      ...(result.error ? { error: result.error } : {}),
    }
  } catch (err) {
    // The one throwing case is a rejected access URL (ProviderAuthError) —
    // not transient; the user must re-link. Reported display-safe.
    return {
      ok: false,
      refreshedCount: 0,
      skippedCount: 0,
      budgetExhausted: false,
      requestsInLastDay: 0,
      error: await describeError(err),
    }
  } finally {
    adapter.dispose()
  }
}

/**
 * Read-only cooldown/budget status — pure cache reads, never touches the
 * network. Returns `available: false` (rather than throwing) when the
 * passphrase isn't resolved or the store can't be opened, so the renderer can
 * render the same "unavailable" affordance it already uses for the
 * connection state.
 */
export async function getSimpleFinRefreshStatus(
  deps: Pick<SimpleFinRefreshDeps, 'loadConfig' | 'getActivePassphrase'>
): Promise<SimpleFinRefreshStatus> {
  const unavailable: SimpleFinRefreshStatus = {
    available: false,
    msUntilRefreshAllowed: 0,
    inSetupGrace: false,
    requestsInLastDay: 0,
    forceRefreshBudgetRemaining: 0,
  }

  const passphrase = deps.getActivePassphrase()
  if (!passphrase) return unavailable

  const config = deps.loadConfig()
  const adapter = await buildAdapter(config, passphrase)
  if (!adapter) return unavailable

  try {
    const status = adapter.instance.getRefreshStatus()
    return {
      available: true,
      msUntilRefreshAllowed: status.msUntilRefreshAllowed,
      inSetupGrace: status.inSetupGrace,
      requestsInLastDay: status.requestsInLastDay,
      forceRefreshBudgetRemaining: status.forceRefreshBudgetRemaining,
    }
  } finally {
    adapter.dispose()
  }
}

// ---- Shared helpers -------------------------------------------------------

interface BuiltAdapter {
  instance: import('@clad/simplefin-adapter').SimpleFinAdapter
  /** Closes the adapter's cache handle AND the token store — both opened here. */
  dispose: () => void
}

/**
 * Builds a `SimpleFinAdapter` over the shared `simplefin_db` file, or
 * `undefined` if the token store can't be opened (e.g. a wrong passphrase,
 * which shouldn't happen since Plaid and SimpleFIN share one custody-resolved
 * passphrase). The returned `dispose` closes both resources — the adapter
 * closes only its own cache, so the token store is closed here explicitly.
 */
async function buildAdapter(
  config: CladConfig,
  passphrase: string,
  fetchImpl?: typeof fetch
): Promise<BuiltAdapter | undefined> {
  const { SqliteTokenStore } = await getCladCore()
  const { SimpleFinAdapter } = await getCladSimpleFinAdapter()

  let tokenStore: InstanceType<typeof SqliteTokenStore>
  try {
    tokenStore = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase })
  } catch {
    return undefined
  }

  const instance = new SimpleFinAdapter({
    tokenStore,
    dbPath: config.simplefin_db,
    passphrase,
    fetch: fetchImpl,
  })

  return {
    instance,
    dispose: () => {
      instance.close()
      tokenStore.close()
    },
  }
}

/**
 * Display-safe error string. The adapter's `SimpleFinError` subclasses,
 * `@clad/core`'s `ProviderAuthError` (a fixed re-link message carrying only a
 * non-secret item id — the sole error `forceRefresh` propagates), and
 * `TokenStoreKeyError` are all pre-sanitized; anything else is passed through
 * `redactSecrets` defensively.
 */
async function describeError(error: unknown): Promise<string> {
  const { SimpleFinError } = await getCladSimpleFinAdapter()
  if (error instanceof SimpleFinError) return error.message
  const { ProviderAuthError, TokenStoreKeyError, redactSecrets } = await getCladCore()
  if (error instanceof ProviderAuthError) return error.message
  if (error instanceof TokenStoreKeyError) return error.message
  if (error instanceof Error) return redactSecrets(error.message)
  return 'unknown error'
}
