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
 * boundary — only `status()`/`has()` (never credential values) are safe to
 * expose to the renderer (security checklist item 1: "Renderer never
 * receives tokens, passphrases, or Plaid credentials").
 *
 * D1 manual QA finding 3: a packaged (differently code-signed) build can't
 * decrypt ciphertext a dev build wrote — macOS Keychain ACLs are tied to the
 * app's code-signing identity, which changes on every unsigned rebuild. The
 * original `has()` only checked file *existence*, so this case looked
 * identical to "never set" from the renderer's point of view: Settings
 * silently showed "Not set", with no indication anything had gone wrong.
 * `status()` below distinguishes the two so the UI can show an actionable
 * message instead (`SettingsForm.tsx`) — the re-enter/reset action is just
 * the existing save()/clear(), which always overwrite unconditionally
 * (`writeSealed`/`deleteSealed` never read-before-write), so no separate
 * "reset" IPC path is needed.
 */

import { join } from 'node:path'
import { writeSealed, readSealed, deleteSealed, sealedFileExists, type SafeStorageLike } from './sealed-file.js'

const CREDENTIALS_FILENAME = 'plaid-credentials.bin'

export interface PlaidCredentials {
  clientId: string
  secret: string
}

/**
 * `'unset'` — nothing saved yet. `'set'` — saved and currently readable.
 * `'undecryptable'` — a sealed file exists but can't be turned back into
 * valid credentials right now (decrypt failure, or garbage after decrypt).
 * Intentionally a standalone copy of the shape mirrored in `shared/ipc.ts`
 * (that file can't import from `src/main/**` — see its own module doc), same
 * pattern already used for `McpServerState`.
 */
export type PlaidCredentialsStatus = 'unset' | 'set' | 'undecryptable'

export class PlaidSecretsStore {
  private readonly filePath: string

  constructor(userDataDir: string, private readonly safeStorage: SafeStorageLike) {
    this.filePath = join(userDataDir, CREDENTIALS_FILENAME)
  }

  /** Display-safe: whether a sealed credentials file exists at all (does not imply it's readable — see `status()`). */
  has(): boolean {
    return sealedFileExists(this.filePath)
  }

  /** Display-safe: distinguishes "nothing saved" from "saved but can't be unlocked right now" — never the credential values themselves. */
  status(): PlaidCredentialsStatus {
    if (!sealedFileExists(this.filePath)) return 'unset'
    return this.load() !== null ? 'set' : 'undecryptable'
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
