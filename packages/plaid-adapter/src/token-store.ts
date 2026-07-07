/**
 * `SqliteTokenStore` — the encrypted at-rest store for Plaid access tokens.
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
 *    `redactSecrets` from `@clad/core` defensively before it can escape.
 *  - The DB file is chmod'd to 0600 at creation and re-applied on reopen.
 *  - `listItems()` returns metadata only (`StoredItemMeta`) — no token field.
 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { redactSecrets } from '@clad/core'
import { deriveKey, encrypt, decrypt, type EncryptedPayload } from './crypto.js'
import { TokenStoreKeyError } from './errors.js'
import type { StoredItemInput, StoredItemMeta, TokenStore } from './token-store.types.js'

export interface SqliteTokenStoreOptions {
  dbPath: string
  passphrase: string
}

/** The plaintext sealed under the derived key to detect wrong passphrases. */
const KEY_CHECK_CONSTANT = 'clad-token-store-key-check-v1'

/** scrypt parameter set recorded in `meta` so future reopens re-derive identically. */
const KDF_NAME = 'scrypt'
const KDF_N = 2 ** 15
const KDF_R = 8
const KDF_P = 1

/** 0600 — owner read/write only. */
const FILE_MODE = 0o600

interface MetaRow {
  kdf_name: string
  kdf_n: number
  kdf_r: number
  kdf_p: number
  salt: Buffer
  key_check_ciphertext: Buffer
  key_check_iv: Buffer
  key_check_auth_tag: Buffer
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
      CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        kdf_name TEXT NOT NULL,
        kdf_n INTEGER NOT NULL,
        kdf_r INTEGER NOT NULL,
        kdf_p INTEGER NOT NULL,
        salt BLOB NOT NULL,
        key_check_ciphertext BLOB NOT NULL,
        key_check_iv BLOB NOT NULL,
        key_check_auth_tag BLOB NOT NULL
      )
    `)
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
    // and re-apply on every open so a drifted mode is corrected.
    this.enforceFileMode()

    const existing = this.db.prepare('SELECT * FROM meta WHERE id = 1').get() as
      | MetaRow
      | undefined

    if (existing === undefined) {
      this.key = this.initializeMeta(options.passphrase)
    } else {
      this.key = this.verifyPassphrase(options.passphrase, existing)
    }

    // Owner-only mode again: the first write may have created the file only now.
    this.enforceFileMode()
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

  /** First open: generate salt, derive key, seal the key-check constant. */
  private initializeMeta(passphrase: string): Buffer {
    const salt = randomBytes(16)
    const key = deriveKey(passphrase, salt)
    const keyCheck = encrypt(key, KEY_CHECK_CONSTANT)

    this.db
      .prepare(
        `INSERT INTO meta (
           id, kdf_name, kdf_n, kdf_r, kdf_p, salt,
           key_check_ciphertext, key_check_iv, key_check_auth_tag
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        KDF_NAME,
        KDF_N,
        KDF_R,
        KDF_P,
        salt,
        keyCheck.ciphertext,
        keyCheck.iv,
        keyCheck.authTag
      )

    return key
  }

  /**
   * Subsequent opens: re-derive the key from the stored salt/params and confirm
   * it decrypts the key-check record to the known constant. Any GCM auth failure
   * (wrong passphrase) or value mismatch throws {@link TokenStoreKeyError}, whose
   * message carries no secret material.
   */
  private verifyPassphrase(passphrase: string, meta: MetaRow): Buffer {
    const key = deriveKey(passphrase, Buffer.from(meta.salt))
    try {
      const decrypted = decrypt(key, {
        ciphertext: Buffer.from(meta.key_check_ciphertext),
        iv: Buffer.from(meta.key_check_iv),
        authTag: Buffer.from(meta.key_check_auth_tag),
      })
      if (decrypted !== KEY_CHECK_CONSTANT) {
        throw new TokenStoreKeyError()
      }
    } catch (err) {
      if (err instanceof TokenStoreKeyError) {
        throw err
      }
      // Any crypto/decrypt failure means the derived key is wrong. Discard the
      // underlying error (it carries no secret, but we never forward it) and
      // surface a fixed, secret-free error instead.
      throw new TokenStoreKeyError()
    }
    return key
  }

  private toPayload(row: ItemRow): EncryptedPayload {
    return {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.auth_tag),
    }
  }

  /** chmod the DB file to 0600, only touching it if the mode has drifted. */
  private enforceFileMode(): void {
    if (this.dbPath === ':memory:') return
    let currentMode: number
    try {
      currentMode = statSync(this.dbPath).mode & 0o777
    } catch {
      // File not created yet (e.g. no write has flushed it); nothing to chmod.
      return
    }
    if (currentMode !== FILE_MODE) {
      chmodSync(this.dbPath, FILE_MODE)
    }
  }
}
