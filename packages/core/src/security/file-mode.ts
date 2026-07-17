/**
 * Shared "restrict this file to owner-only (0600)" helper.
 *
 * Extracted so every module that first-creates or reopens a secret-bearing
 * SQLite file enforces the same permissions the same way: `SqliteTokenStore`
 * (encrypted access tokens) and, since D5.1, the provider caches
 * (`PlaidCache`/`SimpleFinCache`, which now hold AES-256-GCM-encrypted
 * financial rows and may be the first process to create a fresh cache file).
 *
 * Only touches the file when the mode has actually drifted, and treats a
 * not-yet-created file (`:memory:`, or the window before the first write
 * flushes it to disk) as a no-op rather than an error.
 */

import { chmodSync, statSync } from 'node:fs'

/** 0600 — owner read/write only. */
const FILE_MODE = 0o600

/** chmod `dbPath` to 0600, only touching it if the mode has drifted. */
export function enforceFileMode(dbPath: string): void {
  if (dbPath === ':memory:') return
  let currentMode: number
  try {
    currentMode = statSync(dbPath).mode & 0o777
  } catch {
    // File not created yet (e.g. no write has flushed it); nothing to chmod.
    return
  }
  if (currentMode !== FILE_MODE) {
    chmodSync(dbPath, FILE_MODE)
  }
}
