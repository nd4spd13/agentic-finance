/**
 * `SqliteTokenStore` — the encrypted at-rest store for provider access
 * credentials (Plaid access tokens, SimpleFIN access URLs, or any future
 * provider's equivalent "long-lived secret that lets us fetch data").
 *
 * Originally built for `@clad/plaid-adapter` (WP3); moved here (SF5) once the
 * SimpleFIN adapter needed the same encrypted-at-rest storage and the item
 * model (`{ itemId, institutionName, accessToken }`) turned out to already be
 * fully provider-agnostic — nothing about this file is Plaid-specific. Both
 * `@clad/plaid-adapter` and `@clad/simplefin-adapter` depend on `@clad/core`
 * already, so this is the natural shared home (roadmap P4 names this file as
 * "the reference pattern" for local-first storage). `@clad/plaid-adapter`
 * re-exports these names from its own `index.ts` so existing call sites
 * (`clad connect`, `provider-factory.ts`) did not need to change.
 *
 * Backed by `node:sqlite`'s `DatabaseSync` (mirroring the style of
 * `packages/core/src/audit/logger.ts`). Access tokens are encrypted with
 * AES-256-GCM under a key derived from a passphrase via scrypt; the DB file
 * holds only `ciphertext`, `iv`, and `auth_tag` — never plaintext tokens.
 *
 * Security invariants enforced here:
 *  - No method interpolates a token, passphrase, or derived key into an Error
 *    message, thrown object, or any string. There are zero `console.*` calls.
 *  - Any diagnostic string derived from stored data is passed through
 *    `redactSecrets` defensively before it can escape.
 *  - The DB file is chmod'd to 0600 at creation and re-applied on reopen.
 *  - `listItems()` returns metadata only (`StoredItemMeta`) — no token field.
 */

import { DatabaseSync } from 'node:sqlite'
import { redactSecrets } from './redact.js'
import { encrypt, decrypt, type EncryptedPayload } from './crypto.js'
import { openDatabaseKey } from './key-meta.js'
import { enforceFileMode } from './file-mode.js'
import type { StoredItemInput, StoredItemMeta, TokenStore } from './token-store.types.js'

export interface SqliteTokenStoreOptions {
  dbPath: string
  passphrase: string
}

interface ItemRow {
  ciphertext: Buffer
  iv: Buffer
  auth_tag: Buffer
}

export class SqliteTokenStore implements TokenStore {
  private readonly db: DatabaseSync
  private readonly dbPath: string
  private readonly key: Buffer

  constructor(options: SqliteTokenStoreOptions) {
    this.dbPath = options.dbPath
    this.db = new DatabaseSync(options.dbPath)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        item_id TEXT PRIMARY KEY,
        institution_name TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)

    // Restrict the file to owner-only before deriving keys or touching tokens,
    // and re-apply on every open so a drifted mode is corrected. The shared
    // `openDatabaseKey` creates the `meta` table, derives the AES-256 key from
    // the passphrase, and throws `TokenStoreKeyError` on a mismatch.
    enforceFileMode(this.dbPath)
    this.key = openDatabaseKey(this.db, options.passphrase)
    // Owner-only mode again: the first write may have created the file only now.
    enforceFileMode(this.dbPath)
  }

  saveItem(item: StoredItemInput): void {
    const payload = encrypt(this.key, item.accessToken)
    const now = new Date().toISOString()
    // Upsert: keep the original created_at, refresh institution + token + updated_at.
    const stmt = this.db.prepare(`
      INSERT INTO items (item_id, institution_name, ciphertext, iv, auth_tag, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        institution_name = excluded.institution_name,
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `)
    stmt.run(
      item.itemId,
      item.institutionName,
      payload.ciphertext,
      payload.iv,
      payload.authTag,
      now,
      now
    )
  }

  getAccessToken(itemId: string): string {
    const row = this.db
      .prepare('SELECT ciphertext, iv, auth_tag FROM items WHERE item_id = ?')
      .get(itemId) as ItemRow | undefined

    if (row === undefined) {
      // No token material to leak here; the id is caller-supplied, but redact
      // defensively in case a token-shaped value is ever passed as an id.
      throw new Error(redactSecrets(`No stored item found for itemId: ${itemId}`))
    }

    return decrypt(this.key, this.toPayload(row))
  }

  listItems(): StoredItemMeta[] {
    // Note: token columns are deliberately not selected — the return type has
    // no token field, and never reading them keeps plaintext out of memory.
    const rows = this.db
      .prepare(
        'SELECT item_id, institution_name, created_at, updated_at FROM items ORDER BY created_at ASC'
      )
      .all() as Array<{
      item_id: string
      institution_name: string
      created_at: string
      updated_at: string
    }>

    return rows.map((row) => ({
      itemId: row.item_id,
      institutionName: row.institution_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  deleteItem(itemId: string): void {
    this.db.prepare('DELETE FROM items WHERE item_id = ?').run(itemId)
  }

  close(): void {
    this.db.close()
  }

  private toPayload(row: ItemRow): EncryptedPayload {
    return {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.auth_tag),
    }
  }
}
