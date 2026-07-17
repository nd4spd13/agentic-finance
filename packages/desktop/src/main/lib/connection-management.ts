/**
 * Connection management — list and remove (disconnect) the linked items a
 * provider has stored, for the desktop Connect screen (`ConnectView.tsx`).
 *
 * There was previously no way to remove a linked item for either provider;
 * this fills that gap ahead of real production data (and lets a demo
 * SimpleFIN token be cleared before a real one is added). Both providers'
 * long-lived credentials live in the same `SqliteTokenStore` shape
 * (`@clad/core`, re-exported by `@clad/plaid-adapter`) — Plaid at
 * `config.plaid_db`, SimpleFIN at `config.simplefin_db` — plus a per-item
 * SQLite cache in the *same file* (`PlaidCache` / `SimpleFinCache`). Removing
 * an item therefore means: (best-effort) revoke upstream, delete the encrypted
 * token, and purge the item's now-orphaned cache rows.
 *
 * SECURITY (hard rule, same as the rest of `src/main/**`): only display-safe
 * metadata ever leaves this module toward the renderer — `LinkedItem` carries
 * an item id, institution name, and created date, never an access token or
 * access URL. The Plaid access token is read here ONLY to hand it to Plaid's
 * `/item/remove`; it is never returned, logged, or interpolated into any
 * warning/error string. Every error is passed through the adapters' own
 * secret-free error types or `redactSecrets` defensively — same discipline as
 * `plaid-link-flow.ts` / `simplefin-connect.ts`.
 *
 * ESM/CJS: `@clad/core`, `@clad/plaid-adapter`, and `@clad/simplefin-adapter`
 * are ESM-only and would crash this CJS main bundle on a static import — this
 * module only ever reaches them through `getCladCore()` /
 * `getCladPlaidAdapter()` / `getCladSimpleFinAdapter()` (enforced by the
 * desktop eslint override). Type references use the inline
 * `import('@clad/...')...` form so even type-only usage never trips that rule.
 *
 * D3.3: Plaid listing/removal opens `effectivePlaidDbPath(config,
 * config.plaid_env)` — the ACTIVE environment's store/cache file — rather
 * than raw `config.plaid_db`, so list/remove/disconnect only ever sees the
 * currently-selected env's items, consistent with every other Plaid surface
 * (`provider-factory.ts`, `plaid-link-flow.ts`, `mcp-server-env.ts`). `deps`
 * must therefore supply an *effective* config (`main/index.ts`'s
 * `loadEffectiveConfig`) so `config.plaid_env` is already normalized for a
 * packaged build before it reaches this module — same for the credentials
 * `deps.loadPlaidCredentials` supplies, which must come from the ACTIVE
 * env's `PlaidSecretsStore` slot (`getActivePlaidSecrets()` in
 * `main/index.ts`). SimpleFIN has no env concept and is unaffected —
 * `config.simplefin_db` is used as-is below.
 */

import { getCladCore } from './clad-core.js'
import { getCladPlaidAdapter } from './plaid-adapter.js'
import { getCladSimpleFinAdapter } from './simplefin-adapter.js'
import { effectivePlaidDbPath, type CladConfig } from './config.js'

/**
 * Display-safe summary of one cached account under a linked item — never a
 * token/access URL. The account id is the already-namespaced `simplefin:{id}`
 * (or Plaid item-scoped) id, which is not a secret (it is not the access URL);
 * it is carried only as a stable React key. Balances are intentionally omitted
 * — Linked Items answers "what is connected", not "how much is in it" (that is
 * the Dashboard's job).
 */
export interface LinkedAccountSummary {
  accountId: string
  name: string
  /** The account's financial institution, when the provider can resolve one. */
  institution?: string
  type: string
  mask?: string
}

/** Display-safe view of one linked item — never a token/access URL. */
export interface LinkedItem {
  itemId: string
  institutionName: string
  /** ISO-8601 timestamp the item was first stored. */
  createdAt: string
  /**
   * The accounts this item currently spans, from the provider cache — only
   * populated for SimpleFIN, where one access URL/item spans *many*
   * institutions/accounts (institution identity is per-account via `conn_id`,
   * see `simplefin-adapter/src/mapping.ts`). Plaid leaves it `undefined`: one
   * Plaid item is one institution, already named by `institutionName`, so
   * there is nothing to nest. `undefined` (never fetched / no cache) and `[]`
   * (fetched, genuinely no accounts) are distinct and both valid.
   */
  accounts?: LinkedAccountSummary[]
}

/**
 * Result of a remove attempt. `ok: true` means the item's local token +
 * cache were deleted. `warning` is set alongside `ok: true` when the local
 * deletion succeeded but a best-effort upstream revocation could not be
 * completed (Plaid `/item/remove` failed, or credentials weren't available
 * to attempt it) — the item is gone locally either way. Display-safe.
 */
export interface RemoveLinkedItemResult {
  ok: boolean
  warning?: string
  error?: string
}

export interface ConnectionManagementDeps {
  loadConfig: () => CladConfig
  /** `null` when passphrase custody isn't resolved yet (e.g. CLI-migration prompt still pending). */
  getActivePassphrase: () => string | null
  /** `null` when Plaid credentials haven't been saved yet — best-effort revocation is skipped when so. */
  loadPlaidCredentials: () => { clientId: string; secret: string } | null
  /**
   * Test-only seam: builds the Plaid API client used for best-effort
   * `/item/remove`. Real callers omit it — it defaults to `createPlaidClient`
   * (from `@clad/plaid-adapter`). Tests inject a fake `PlaidClientLike` so no
   * test ever touches the real Plaid network — same seam as
   * `plaid-link-flow.ts`.
   */
  createClient?: (
    creds: { clientId: string; secret: string },
    plaidEnv: CladConfig['plaid_env']
  ) => import('@clad/plaid-adapter').PlaidClientLike
}

type ListDeps = Pick<ConnectionManagementDeps, 'loadConfig' | 'getActivePassphrase'>

// ---- Plaid ----------------------------------------------------------------

/**
 * Lists the Plaid items currently stored. Returns `[]` (rather than throwing)
 * when the passphrase isn't resolved yet — the Connect screen already reports
 * that separately as an `'unavailable'` connection state; there is simply
 * nothing listable until custody is resolved. A genuine store-open failure
 * (e.g. a wrong passphrase, which shouldn't happen since Plaid and SimpleFIN
 * share one custody-resolved passphrase) does propagate, so the renderer can
 * surface a real error rather than a silently-empty list.
 */
export async function listPlaidItems(deps: ListDeps): Promise<LinkedItem[]> {
  const passphrase = deps.getActivePassphrase()
  if (!passphrase) return []

  const config = deps.loadConfig()
  const { SqliteTokenStore } = await getCladPlaidAdapter()

  const store = new SqliteTokenStore({ dbPath: effectivePlaidDbPath(config, config.plaid_env), passphrase })
  try {
    return store.listItems().map(toLinkedItem)
  } finally {
    store.close()
  }
}

/**
 * Removes (disconnects) a single Plaid item: best-effort `/item/remove`
 * revocation first (only when credentials are available), then deletes the
 * encrypted token and purges the item's cache rows locally. Never throws —
 * every failure path returns `{ ok: false, error }` so the IPC handler in
 * `main/index.ts` stays a plain pass-through. Local deletion still happens
 * even when revocation fails (surfaced via `warning`): a token we can't
 * revoke upstream is strictly worse to also keep locally.
 */
export async function removePlaidItem(
  itemId: string,
  deps: ConnectionManagementDeps
): Promise<RemoveLinkedItemResult> {
  const passphrase = deps.getActivePassphrase()
  if (!passphrase) {
    return {
      ok: false,
      error: 'The token-store passphrase is not resolved yet — finish the migration/setup prompt first.',
    }
  }

  const config = deps.loadConfig()
  const { SqliteTokenStore, PlaidCache, createPlaidClient } = await getCladPlaidAdapter()

  let store: InstanceType<typeof SqliteTokenStore>
  try {
    store = new SqliteTokenStore({ dbPath: effectivePlaidDbPath(config, config.plaid_env), passphrase })
  } catch (err) {
    return { ok: false, error: await describePlaidError(err) }
  }

  let warning: string | undefined
  try {
    // Read the access token BEFORE deleting it — only ever to hand to
    // `/item/remove`; it is never returned, logged, or put in a string below.
    // A missing item (already gone) is not an error: fall through to purge
    // any orphaned cache rows and report success.
    let accessToken: string | null = null
    try {
      accessToken = store.getAccessToken(itemId)
    } catch {
      accessToken = null
    }

    const creds = deps.loadPlaidCredentials()
    if (accessToken && creds) {
      try {
        const client = deps.createClient
          ? deps.createClient(creds, config.plaid_env)
          : createPlaidClient({ clientId: creds.clientId, secret: creds.secret, env: config.plaid_env })
        await client.itemRemove({ access_token: accessToken })
      } catch (err) {
        warning =
          'Removed locally, but revoking the connection with Plaid failed: ' +
          (await describePlaidError(err)) +
          ' The access token may remain active on Plaid’s side until it expires.'
      }
    } else if (accessToken && !creds) {
      warning =
        'Removed locally. Plaid credentials are not available, so the access token could not be revoked with Plaid — add your Client ID/Secret in Settings to revoke on removal.'
    }

    store.deleteItem(itemId)
  } catch (err) {
    return { ok: false, error: await describePlaidError(err) }
  } finally {
    store.close()
  }

  // Purge the item's cache rows (accounts_cache/transactions_cache/cursors in
  // the same sqlite file). Opened separately from the token store above (each
  // owns disjoint tables in the file). A cache-purge failure after the token
  // is already gone shouldn't flip the whole result to failure — the item IS
  // removed — so surface it as a warning instead.
  try {
    const cache = new PlaidCache(effectivePlaidDbPath(config, config.plaid_env))
    try {
      cache.removeItem(itemId)
    } finally {
      cache.close()
    }
  } catch (err) {
    const cacheWarning = 'The connection was removed, but purging its cached data failed: ' + (await describePlaidError(err))
    warning = warning ? `${warning} ${cacheWarning}` : cacheWarning
  }

  return { ok: true, warning }
}

// ---- SimpleFIN ------------------------------------------------------------

/**
 * Lists the SimpleFIN items currently stored — same contract as
 * `listPlaidItems`, against `config.simplefin_db` via `@clad/core`'s
 * `SqliteTokenStore` (the same store `simplefin-connect.ts` writes to) — plus
 * each item's cached accounts (institution + name + type + mask), so the
 * Connect screen can show the real institutions/accounts an access URL spans
 * rather than only the generic "SimpleFIN Bridge" item label. The accounts
 * come from the same `SimpleFinCache` (same DB file, disjoint tables) the
 * adapter fills on every fetch — a pure read here, never a network call, so
 * listing costs nothing against the Bridge quota.
 *
 * Reading the cache is best-effort: a cache-open/read failure must not break
 * the (more important) item list, so it degrades to `accounts: undefined` for
 * every item rather than propagating. An item with no cached accounts yet
 * (e.g. the initial summary fetch failed at connect time) likewise gets
 * `undefined` — the UI treats "no account detail available" the same either
 * way.
 */
export async function listSimpleFinItems(deps: ListDeps): Promise<LinkedItem[]> {
  const passphrase = deps.getActivePassphrase()
  if (!passphrase) return []

  const config = deps.loadConfig()
  const { SqliteTokenStore } = await getCladCore()

  const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase })
  let metas: import('@clad/core').StoredItemMeta[]
  try {
    metas = store.listItems()
  } finally {
    store.close()
  }

  const accountsByItem = await readSimpleFinAccountsByItem(config.simplefin_db, metas)
  return metas.map((meta) => ({ ...toLinkedItem(meta), accounts: accountsByItem.get(meta.itemId) }))
}

/**
 * Best-effort read of each item's cached accounts, mapped to display-safe
 * summaries. Returns an empty map (every item -> `undefined` accounts) if the
 * cache can't be opened at all — see `listSimpleFinItems`. Opened read-only
 * and closed here; the token store above is already closed by this point.
 */
async function readSimpleFinAccountsByItem(
  dbPath: string,
  metas: import('@clad/core').StoredItemMeta[]
): Promise<Map<string, LinkedAccountSummary[] | undefined>> {
  const result = new Map<string, LinkedAccountSummary[] | undefined>()
  let cache: InstanceType<Awaited<ReturnType<typeof getCladSimpleFinAdapter>>['SimpleFinCache']> | undefined
  try {
    const { SimpleFinCache } = await getCladSimpleFinAdapter()
    cache = new SimpleFinCache({ dbPath })
    for (const meta of metas) {
      const accounts = cache.getAccounts(meta.itemId).map(toLinkedAccountSummary)
      // Distinguish "fetched, has accounts" from "nothing cached yet": only a
      // non-empty list is worth nesting; an empty one reads as `undefined`.
      result.set(meta.itemId, accounts.length > 0 ? accounts : undefined)
    }
  } catch {
    // Leave the map empty — callers get `undefined` accounts for every item.
  } finally {
    cache?.close()
  }
  return result
}

/**
 * Removes (disconnects) a single SimpleFIN item. There is NO revoke API — the
 * SimpleFIN Bridge protocol has no equivalent of Plaid's `/item/remove`, so
 * removal is local-only; the access URL stored here is dropped, but a copy may
 * still exist on the Bridge until the user revokes it there. The UI copy says
 * as much. Never throws — mirrors `removePlaidItem`.
 */
export async function removeSimpleFinItem(
  itemId: string,
  deps: Pick<ConnectionManagementDeps, 'loadConfig' | 'getActivePassphrase'>
): Promise<RemoveLinkedItemResult> {
  const passphrase = deps.getActivePassphrase()
  if (!passphrase) {
    return {
      ok: false,
      error: 'The token-store passphrase is not resolved yet — finish the migration/setup prompt first.',
    }
  }

  const config = deps.loadConfig()
  const { SqliteTokenStore } = await getCladCore()

  let store: InstanceType<typeof SqliteTokenStore>
  try {
    store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase })
  } catch (err) {
    return { ok: false, error: await describeCoreError(err) }
  }

  try {
    store.deleteItem(itemId)
  } catch (err) {
    return { ok: false, error: await describeCoreError(err) }
  } finally {
    store.close()
  }

  let warning: string | undefined
  try {
    const { SimpleFinCache } = await getCladSimpleFinAdapter()
    const cache = new SimpleFinCache({ dbPath: config.simplefin_db })
    try {
      cache.removeItem(itemId)
    } finally {
      cache.close()
    }
  } catch (err) {
    warning = 'The connection was removed, but purging its cached data failed: ' + (await describeCoreError(err))
  }

  return { ok: true, warning }
}

// ---- Shared helpers -------------------------------------------------------

function toLinkedItem(meta: import('@clad/core').StoredItemMeta): LinkedItem {
  return { itemId: meta.itemId, institutionName: meta.institutionName, createdAt: meta.createdAt }
}

/** Maps a cached account to its display-safe summary — drops balances/currency and the itemId tag, keeps only what Linked Items shows. */
function toLinkedAccountSummary(
  account: import('@clad/simplefin-adapter').CachedAccount
): LinkedAccountSummary {
  return {
    accountId: account.id,
    name: account.name,
    institution: account.institution,
    type: account.type,
    mask: account.mask,
  }
}

/**
 * User-facing error string for the Plaid path. `TokenStoreKeyError` /
 * `LinkFlowError` already carry secret-free messages; anything else (an axios
 * error from `/item/remove`, a SQLite error) is passed through `redactSecrets`
 * defensively — same discipline as `plaid-link-flow.ts`'s `describeError`.
 */
async function describePlaidError(error: unknown): Promise<string> {
  const { LinkFlowError, TokenStoreKeyError } = await getCladPlaidAdapter()
  if (error instanceof LinkFlowError) return error.message
  if (error instanceof TokenStoreKeyError) return error.message
  const { redactSecrets } = await getCladCore()
  return redactSecrets(error instanceof Error ? error.message : String(error))
}

/** User-facing error string for the SimpleFIN/core path — `TokenStoreKeyError` is already secret-free; everything else is redacted defensively. */
async function describeCoreError(error: unknown): Promise<string> {
  const { TokenStoreKeyError, redactSecrets } = await getCladCore()
  if (error instanceof TokenStoreKeyError) return error.message
  return redactSecrets(error instanceof Error ? error.message : String(error))
}
