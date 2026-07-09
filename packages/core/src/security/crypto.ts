/**
 * Pure cryptographic primitives for the encrypted Plaid token store.
 *
 * These are thin, side-effect-free wrappers over `node:crypto`. They perform
 * no logging, throw no messages that embed secret material, and hold no state.
 * The token store (`token-store.ts`) composes them; keeping them pure makes the
 * crypto independently testable (round-trip, IV uniqueness, tamper rejection).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * scrypt cost parameters for deriving the AES-256 key from a passphrase.
 *
 * Constraint: interactive-login-grade KDF hardness. `clad connect` derives the
 * key once per process from a human-supplied passphrase (or `CLAD_TOKEN_PASSPHRASE`
 * in server mode), so a cost on the order of ~100 ms on commodity hardware is the
 * right trade-off — high enough to make offline brute-force of a stolen DB file
 * expensive, low enough not to stall an interactive command.
 *
 * N = 2^15 (32768), r = 8, p = 1 → the classic scrypt "interactive" profile.
 * keylen = 32 bytes → a 256-bit key for AES-256-GCM.
 *
 * maxmem must be raised above Node's 32 MiB default: scrypt's memory use is
 * roughly 128 * N * r bytes ≈ 32 MiB here, which sits exactly at/over the default
 * ceiling and would otherwise throw. 64 MiB gives comfortable headroom.
 */
const SCRYPT_N = 2 ** 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/** AES-256-GCM uses a 12-byte (96-bit) IV — the value NIST recommends for GCM. */
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const ALGORITHM = 'aes-256-gcm'

/** An AES-256-GCM ciphertext together with the parameters needed to decrypt it. */
export interface EncryptedPayload {
  ciphertext: Buffer
  iv: Buffer
  authTag: Buffer
}

/**
 * Derives a 32-byte AES-256 key from a passphrase and salt using scrypt.
 * Deterministic: the same (passphrase, salt) always yields the same key, which
 * is what lets the token store re-derive the key on reopen from the stored salt.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
}

/**
 * Encrypts `plaintext` under `key` with AES-256-GCM, using a fresh random
 * 12-byte IV on every call. Returns the ciphertext, IV, and GCM auth tag; the
 * caller persists all three (the IV and tag are not secret, but are required —
 * and integrity-protective — for decryption).
 */
export function encrypt(key: Buffer, plaintext: string): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { ciphertext, iv, authTag }
}

/**
 * Decrypts an {@link EncryptedPayload} under `key`, returning the UTF-8
 * plaintext. Throws if the ciphertext, IV, or auth tag has been tampered with,
 * or if the key is wrong: AES-GCM authentication fails closed. The thrown error
 * carries only the generic crypto failure message — never the key or plaintext.
 */
export function decrypt(key: Buffer, payload: EncryptedPayload): string {
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })
  decipher.setAuthTag(payload.authTag)
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]).toString('utf8')
}
