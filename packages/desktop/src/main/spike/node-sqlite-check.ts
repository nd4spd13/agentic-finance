/**
 * S0.2 spike — `node:sqlite` inside Electron's main process.
 *
 * Constructs a real `SqliteTokenStore` (from `@clad/plaid-adapter`) against a
 * throwaway temp DB file and a fixed test passphrase, writes one fake item,
 * and reads it back. This must succeed both in `electron-vite dev` and in the
 * packaged (ASAR) app — see `packages/docs/plans/desktop-app.md` S0.2.
 *
 * `@clad/plaid-adapter` (and `@clad/core` — see `../lib/clad-core.ts`) are
 * ESM-only (their `exports` maps have no `require` condition). Electron's
 * main process bundle here is CommonJS (electron-vite default), so a
 * *static* `import` would be rewritten to a top-level `require()` call and
 * throw at module load (`ERR_PACKAGE_PATH_NOT_EXPORTED` / `ERR_REQUIRE_ESM`
 * depending on the exact exports shape) — before any spike code even runs.
 * A dynamic `import()` sidesteps that — the same seam already used in
 * `packages/mcp-server/src/provider-factory.ts` for `@clad/plaid-adapter`.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCladCore } from '../lib/clad-core.js'
import type { NodeSqliteSpikeResult } from '../../shared/ipc.js'

const TEST_ITEM_ID = 'spike-item-1'
const TEST_ACCESS_TOKEN = 'access-sandbox-spike-fake-token-do-not-use'
const TEST_PASSPHRASE = 'spike-test-passphrase-do-not-use'

export async function runNodeSqliteSpike(): Promise<NodeSqliteSpikeResult> {
  const electronVersion = process.versions.electron ?? 'unknown'
  const bundledNodeVersion = process.versions.node

  const dir = mkdtempSync(join(tmpdir(), 'clad-desktop-spike-'))
  const dbPath = join(dir, 'spike-token-store.sqlite')

  try {
    const { SqliteTokenStore } = await import('@clad/plaid-adapter')

    const store = new SqliteTokenStore({ dbPath, passphrase: TEST_PASSPHRASE })
    store.saveItem({
      itemId: TEST_ITEM_ID,
      institutionName: 'Spike Test Bank',
      accessToken: TEST_ACCESS_TOKEN,
    })
    const roundTripped = store.getAccessToken(TEST_ITEM_ID)
    const items = store.listItems()
    store.close()

    const ok =
      roundTripped === TEST_ACCESS_TOKEN &&
      items.length === 1 &&
      items[0].itemId === TEST_ITEM_ID &&
      items[0].institutionName === 'Spike Test Bank'

    return { ok, backend: 'node:sqlite', electronVersion, bundledNodeVersion }
  } catch (err) {
    const { redactSecrets } = await getCladCore()
    return {
      ok: false,
      backend: 'none',
      electronVersion,
      bundledNodeVersion,
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
