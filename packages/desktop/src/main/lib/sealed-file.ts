/**
 * Low-level helper: seal a short secret string to disk via Electron's
 * `safeStorage` (Keychain/DPAPI/libsecret-backed), at `0600`, mirroring
 * `token-store.ts`'s file-mode discipline. Shared by `passphrase.ts` (the
 * token-store passphrase) and `plaid-secrets.ts` (the Plaid Client
 * ID/Secret) — both are "one secret string, safeStorage-sealed, 0600 file"
 * underneath, differing only in what plaintext they seal and where.
 *
 * Takes `safeStorage` as a parameter (an interface, not the `electron`
 * import) rather than importing `electron` directly, so this module — and
 * everything built on it — is importable and testable under plain Vitest,
 * where the real `electron` module's exports don't exist. Real callers pass
 * the actual `safeStorage` export; tests pass a fake.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** 0600 — owner read/write only. */
const FILE_MODE = 0o600

function enforceFileMode(path: string): void {
  try {
    const currentMode = statSync(path).mode & 0o777
    if (currentMode !== FILE_MODE) {
      chmodSync(path, FILE_MODE)
    }
  } catch {
    // Not created yet; nothing to chmod.
  }
}

export function sealedFileExists(path: string): boolean {
  return existsSync(path)
}

export function writeSealed(path: string, plaintext: string, safeStorage: SafeStorageLike): void {
  const ciphertext = safeStorage.encryptString(plaintext)
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, ciphertext)
  enforceFileMode(path)
}

/** Returns `null` if no sealed file exists at `path` yet. */
export function readSealed(path: string, safeStorage: SafeStorageLike): string | null {
  if (!existsSync(path)) return null
  const ciphertext = readFileSync(path)
  const plaintext = safeStorage.decryptString(ciphertext)
  enforceFileMode(path)
  return plaintext
}

export function deleteSealed(path: string): void {
  try {
    if (existsSync(path)) {
      rmSync(path)
    }
  } catch {
    // Best-effort — a leftover file here is not a correctness problem for
    // callers, which always re-derive/re-seal after calling this.
  }
}
