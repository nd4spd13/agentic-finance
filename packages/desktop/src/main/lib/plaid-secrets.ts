/**
 * safeStorage-backed storage for the Plaid `CLIENT_ID` / `SECRET` entered in
 * the desktop app's Settings screen.
 *
 * The CLI takes these from the environment only and never writes them to
 * `config.json` (see `connect.ts`, `provider-factory.ts`). The desktop app
 * has no shell to set env vars from, so it needs an at-rest home for them —
 * but "never plaintext" (desktop-app.md, D1.1, and roadmap P2/P4) still
 * applies. `safeStorage` is the same custody mechanism `passphrase.ts` uses
 * for the token-store passphrase; this module is deliberately symmetric to
 * it (same `sealed-file.ts` primitives, same DI-for-testability shape).
 *
 * `load()` is main-process-only. Its return value must never cross the IPC
 * boundary — only `has()` (a boolean) is safe to expose to the renderer
 * (security checklist item 1: "Renderer never receives tokens, passphrases,
 * or Plaid credentials").
 */

import { join } from 'node:path'
import { writeSealed, readSealed, deleteSealed, sealedFileExists, type SafeStorageLike } from './sealed-file.js'

const CREDENTIALS_FILENAME = 'plaid-credentials.bin'

export interface PlaidCredentials {
  clientId: string
  secret: string
}

export class PlaidSecretsStore {
  private readonly filePath: string

  constructor(userDataDir: string, private readonly safeStorage: SafeStorageLike) {
    this.filePath = join(userDataDir, CREDENTIALS_FILENAME)
  }

  /** Display-safe: whether credentials are set, never their value. */
  has(): boolean {
    return sealedFileExists(this.filePath)
  }

  save(creds: PlaidCredentials): { ok: boolean; error?: string } {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS-level encryption (Keychain / DPAPI / libsecret) is not available on this machine.' }
    }
    if (!creds.clientId.trim() || !creds.secret.trim()) {
      return { ok: false, error: 'Client ID and secret must both be non-empty.' }
    }
    try {
      writeSealed(this.filePath, JSON.stringify(creds), this.safeStorage)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Main-process-only. The result of this call must never be forwarded to
   * the renderer or logged — see the module doc comment.
   */
  load(): PlaidCredentials | null {
    try {
      const raw = readSealed(this.filePath, this.safeStorage)
      if (raw === null) return null
      const parsed = JSON.parse(raw) as Partial<PlaidCredentials>
      if (typeof parsed.clientId !== 'string' || typeof parsed.secret !== 'string') return null
      return { clientId: parsed.clientId, secret: parsed.secret }
    } catch {
      return null
    }
  }

  clear(): void {
    deleteSealed(this.filePath)
  }
}
