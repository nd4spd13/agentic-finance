/**
 * Shared "unlock this SQLite file's encryption key" helper.
 *
 * Both `SqliteTokenStore` (which owns the `meta`/`items` tables) and the
 * provider caches (`PlaidCache`/`SimpleFinCache`, which own the encrypted
 * `*_cache`/`cursors` tables in the *same* file — D5.1) need the identical
 * AES-256 key: derived from the identical passphrase via scrypt and checked
 * against the identical key-check seal. That logic used to live inside
 * `SqliteTokenStore` (its `initializeMeta`/`verifyPassphrase`); it is extracted
 * here unchanged so the caches can call it against their own open
 * `DatabaseSync` handle without depending on the token store, and so there is
 * exactly one `meta` row, one salt, one key-check, and one derived key per file
 * no matter which module opens it first (they share one passphrase).
 *
 * Security invariants (match `token-store.ts`):
 *  - No passphrase, derived key, or plaintext is ever interpolated into a
 *    thrown message. A passphrase mismatch throws {@link TokenStoreKeyError},
 *    whose message is a fixed, secret-free constant. There are zero
 *    `console.*` calls.
 *
 * scrypt runs on the order of ~100 ms per open; that cost is paid once per
 * process per file and is the same trade-off the token store already accepts.
 */

import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { deriveKey, encrypt, decrypt } from './crypto.js'
import { TokenStoreKeyError } from './token-store-errors.js'

/** The plaintext sealed under the derived key to detect wrong passphrases. */
const KEY_CHECK_CONSTANT = 'clad-token-store-key-check-v1'

/** scrypt parameter set recorded in `meta` so future reopens re-derive identically. */
const KDF_NAME = 'scrypt'
const KDF_N = 2 ** 15
const KDF_R = 8
const KDF_P = 1

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

/**
 * Ensures the `meta` table exists on `db`, then either initializes it (first
 * open of a fresh file: generate a random salt, derive the key, seal the
 * key-check constant) or verifies `passphrase` against the existing key-check
 * record. Returns the derived 32-byte AES-256 key.
 *
 * Throws {@link TokenStoreKeyError} when the passphrase does not match the one
 * that originally sealed the file. The `CREATE TABLE IF NOT EXISTS` DDL is
 * idempotent, so it is safe for both the token store and a cache to call this
 * on the same file — whichever opens first creates the `meta` row; the later
 * opener verifies against it with the same shared passphrase.
 */
export function openDatabaseKey(db: DatabaseSync, passphrase: string): Buffer {
  db.exec(`
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

  const existing = db.prepare('SELECT * FROM meta WHERE id = 1').get() as MetaRow | undefined

  if (existing === undefined) {
    return initializeMeta(db, passphrase)
  }
  return verifyPassphrase(passphrase, existing)
}

/** First open: generate salt, derive key, seal the key-check constant. */
function initializeMeta(db: DatabaseSync, passphrase: string): Buffer {
  const salt = randomBytes(16)
  const key = deriveKey(passphrase, salt)
  const keyCheck = encrypt(key, KEY_CHECK_CONSTANT)

  db.prepare(
    `INSERT INTO meta (
       id, kdf_name, kdf_n, kdf_r, kdf_p, salt,
       key_check_ciphertext, key_check_iv, key_check_auth_tag
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(KDF_NAME, KDF_N, KDF_R, KDF_P, salt, keyCheck.ciphertext, keyCheck.iv, keyCheck.authTag)

  return key
}

/**
 * Subsequent opens: re-derive the key from the stored salt/params and confirm
 * it decrypts the key-check record to the known constant. Any GCM auth failure
 * (wrong passphrase) or value mismatch throws {@link TokenStoreKeyError}, whose
 * message carries no secret material.
 */
function verifyPassphrase(passphrase: string, meta: MetaRow): Buffer {
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
