/**
 * Connected-clients management — list and revoke the OAuth grants issued to
 * MCP clients (e.g. Claude Desktop, Claude Code) connecting through this
 * app's supervised MCP child, for the Connect screen's "Connected clients"
 * section (D5.3 WS4 S1-S2; see `.claude/plans/d5.3/WS4-consent-revocation-ui.md`
 * §4-5).
 *
 * Reuses `@clad/core`'s `SqliteGrantStore` (WS5) with the SAME
 * already-resolved token-store passphrase every other provider store in this
 * app uses (`getActiveTokenStorePassphrase` in `main/index.ts`) — zero new
 * key custody, per WS5 §3's "Desktop wiring (WS4)" note. `grants.sqlite`
 * (`config.grant_db`) is its own file, opened and closed per call — same
 * short-lived-handle shape as `connection-management.ts`'s Plaid/SimpleFIN
 * list/remove functions, not a long-lived singleton.
 *
 * SECURITY (hard rule, same as `connection-management.ts`): only display-safe
 * `ConnectedClient` metadata ever leaves this module toward the renderer —
 * never a client secret, or any token/auth-code hash. `@clad/core`'s
 * `GrantMeta` already enforces this at the store layer (`listGrants` selects
 * display columns only — see `grant-store.ts`'s module doc); this module does
 * a field-for-field mapping and introduces no new secret-bearing column.
 * Every error string returned crosses IPC only after `describeGrantStoreError`
 * — a fixed `TokenStoreKeyError` message or `redactSecrets` — same discipline
 * as `connection-management.ts`'s `describeCoreError`.
 *
 * ESM/CJS: `@clad/core` is ESM-only and would crash this CJS main bundle on a
 * static import — this module only ever reaches it through `getCladCore()`
 * (enforced by the desktop eslint override), same as every other
 * `src/main/lib/*` module that touches `@clad/core`.
 *
 * Neither function here ever touches Electron (`ipcMain`/`BrowserWindow`) —
 * same DI'd, Electron-free shape as `connection-management.ts`'s exports.
 * Pushing the `connectedClientsChanged` update after a successful revoke is
 * the IPC handler's job in `main/index.ts` (it already holds the `mainWindow`
 * reference), not this module's.
 */

import { getCladCore } from './clad-core.js'
import type { CladConfig } from './config.js'

/**
 * Display-safe view of one issued OAuth grant — a standalone copy of
 * `@clad/core`'s `GrantMeta`, field-for-field EXCEPT `clientId`: `profileId`
 * is the trustworthy, server-chosen identity this UI hangs its hierarchy on
 * (WS4 §4.3/§7 — "Client identity display"), and `grantId` alone is
 * sufficient to key/revoke a row, so the raw DCR client id adds no display
 * value. NEVER a token, client secret, or authorization code.
 */
export interface ConnectedClient {
  grantId: string
  /**
   * Self-reported by the client at DCR (RFC 7591) — UNTRUSTED display text.
   * Never imply verification; `profileId` is the field a human should trust.
   */
  clientName?: string
  /** The bound agent profile — server-chosen at consent, immutable thereafter. The trustworthy field. */
  profileId: string
  /** Minted server-side from policy at consent (WS2 §6). */
  scopes: string[]
  /** Whether this grant's token is sender-constrained (DPoP-bound; M3). */
  dpopBound: boolean
  createdAt: string
  /** Last time a request presented a token for this grant; `null` if never used. */
  lastUsedAt: string | null
  revoked: boolean
  /** Trust assurance recorded at consent (WS7 seam) — D5.3 only ever produces `'local-consent'`. */
  assuranceLevel: 'none' | 'local-consent' | 'attested'
  /** Highest scope sensitivity this grant's client may hold, recorded at consent (WS7 seam). */
  maxScopeSensitivity: 'low' | 'high'
}

export interface RevokeClientResult {
  ok: boolean
  /** Display-safe (redacted where derived from stored/thrown data). */
  error?: string
}

export interface ConnectedClientsDeps {
  loadConfig: () => CladConfig
  /** `null` when passphrase custody isn't resolved yet — same seam as `connection-management.ts`'s `ListDeps`. */
  getActivePassphrase: () => string | null
}

/**
 * Lists every grant currently in the store — revoked ones included (flagged
 * via `revoked`; nothing here filters them, the section decides how/whether
 * to show them). Returns `[]` — and NEVER throws — both when the passphrase
 * isn't resolved yet and when the store itself can't be opened (wrong/rotated
 * passphrase, corrupt file, or the D4.3 unsigned-rebuild degradation — see
 * WS5 §5). This is deliberately MORE defensive than `listPlaidItems`'s
 * "propagate a genuine store-open failure" stance: WS5 §5 calls for a silent
 * degrade to empty here, since a lost grant store's tokens are already
 * worthless to every connected client (their only copy is gone too) and the
 * fix is just re-running the OAuth flow — nothing for this list to preserve
 * or for the user to act on beyond that.
 */
export async function listConnectedClients(deps: ConnectedClientsDeps): Promise<ConnectedClient[]> {
  const passphrase = deps.getActivePassphrase()
  if (!passphrase) return []

  const config = deps.loadConfig()
  const { SqliteGrantStore } = await getCladCore()

  let store: InstanceType<typeof SqliteGrantStore>
  try {
    store = new SqliteGrantStore({ dbPath: config.grant_db, passphrase })
  } catch {
    // Undecryptable / corrupt / mismatched passphrase — degrade to an empty
    // list rather than throw or crash (see doc comment above).
    return []
  }

  try {
    return store.listGrants().map(toConnectedClient)
  } catch {
    return []
  } finally {
    store.close()
  }
}

/**
 * Revokes a single grant: `store.revokeGrant` cascade-deletes its tokens and
 * auth codes (WS5 §3), so the child's LIVE `verifyAccessToken` lookup 401s
 * the very next request — no restart, no cache to invalidate (WS4 §4.2).
 * Never throws — every failure path (unresolved passphrase, store-open
 * failure, or a thrown revoke) returns `{ ok: false, error }` with a
 * redacted, display-safe message, matching `removePlaidItem`'s convention
 * exactly. Revoking an id that doesn't exist (already gone, or never
 * existed) is a no-op at the SQL layer — no rows match, nothing throws —
 * and this returns `{ ok: true }` for that case too: the end state ("this
 * grantId is not an active grant") is identical either way.
 *
 * Pushing `connectedClientsChanged` afterward is the caller's job
 * (`main/index.ts`'s IPC handler, which holds the `mainWindow` reference) —
 * this module stays Electron-free like every other `main/lib/**` manager.
 */
export async function revokeConnectedClient(
  grantId: string,
  deps: ConnectedClientsDeps
): Promise<RevokeClientResult> {
  const passphrase = deps.getActivePassphrase()
  if (!passphrase) {
    return {
      ok: false,
      error: 'The token-store passphrase is not resolved yet — finish the migration/setup prompt first.',
    }
  }

  const config = deps.loadConfig()
  const { SqliteGrantStore } = await getCladCore()

  let store: InstanceType<typeof SqliteGrantStore>
  try {
    store = new SqliteGrantStore({ dbPath: config.grant_db, passphrase })
  } catch (err) {
    return { ok: false, error: await describeGrantStoreError(err) }
  }

  try {
    store.revokeGrant(grantId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: await describeGrantStoreError(err) }
  } finally {
    store.close()
  }
}

function toConnectedClient(meta: import('@clad/core').GrantMeta): ConnectedClient {
  return {
    grantId: meta.grantId,
    clientName: meta.clientName,
    profileId: meta.profileId,
    scopes: meta.scopes,
    dpopBound: meta.dpopBound,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt ?? null,
    revoked: meta.revoked,
    assuranceLevel: meta.assuranceLevel,
    maxScopeSensitivity: meta.maxScopeSensitivity,
  }
}

/**
 * Secret-free error string for the grant-store path. `TokenStoreKeyError`
 * (thrown by `openDatabaseKey` on a wrong/mismatched passphrase) already
 * carries a fixed, secret-free message; anything else is passed through
 * `redactSecrets` defensively — same discipline as `connection-management.ts`'s
 * `describeCoreError`.
 */
async function describeGrantStoreError(error: unknown): Promise<string> {
  const { TokenStoreKeyError, redactSecrets } = await getCladCore()
  if (error instanceof TokenStoreKeyError) return error.message
  return redactSecrets(error instanceof Error ? error.message : String(error))
}
