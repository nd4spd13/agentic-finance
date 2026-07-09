/**
 * safeStorage-backed passphrase custody for the Plaid token store —
 * production version of the S0.3 spike (`src/main/spike/passphrase-
 * custody.ts`, now removed), extended with the CLI-migration flow the spike
 * identified as a real D1 requirement rather than a footnote:
 *
 * > "a user who already has a CLI-managed `~/.clad/plaid.sqlite` cannot have
 * > the desktop app silently take it over with a different passphrase. D1.1
 * > needs an explicit one-time flow: detect an existing CLI-style store,
 * > prompt once for the CLI passphrase, re-encrypt under a new
 * > desktop-managed random passphrase (or reuse the same DB with the CLI
 * > passphrase wrapped by safeStorage instead of memorized) — this is a
 * > real D1 task, not a footnote."
 * > — "Spike results", S0.3, packages/docs/plans/desktop-app.md
 *
 * Decision: **wrap the CLI passphrase**, not re-encrypt the database. See
 * `adoptPassphrase` below for the reasoning (short version: it keeps the
 * CLI and desktop app reading the exact same store under the exact same
 * passphrase — true interop — and never rewrites/re-derives keys for
 * existing ciphertext, which would be needless risk for zero benefit).
 *
 * `PassphraseCustody` takes `safeStorage` as an injected dependency (see
 * `sealed-file.ts`) so its branching logic — generate vs. load vs. migrate
 * vs. reset — is unit-testable under plain Vitest without a live Electron
 * process. The real singleton (constructed with the actual `app`/
 * `safeStorage` electron exports) is assembled in `src/main/index.ts`.
 */

import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  writeSealed,
  readSealed,
  deleteSealed,
  sealedFileExists,
  type SafeStorageLike,
} from './sealed-file.js'
import { getCladPlaidAdapter } from './plaid-adapter.js'
import { getCladCore } from './clad-core.js'

const PASSPHRASE_FILENAME = 'passphrase.bin'

/**
 * `'undecryptable'` (D1 manual QA finding 3): a sealed passphrase file
 * exists but this OS keychain can't open it right now — e.g. macOS Keychain
 * ACLs are tied to the app's code-signing identity, which changes on every
 * unsigned rebuild, so a packaged build can't decrypt ciphertext a dev build
 * wrote. Distinct from `'unavailable'` (the encryption subsystem itself is
 * missing/disabled) so callers can route to a "re-enter/reset" prompt
 * (`computeMigrationStatus` in `index.ts` treats this the same as the
 * existing CLI-migration-needed case) instead of a generic, unexplained
 * failure — this used to be silently swallowed: the sealed file's existence
 * alone made `hasCustodyFile()` true, so `computeMigrationStatus` reported
 * "no migration needed" and the app just never got a working passphrase,
 * with nothing surfaced to the user.
 */
export type PassphraseSource =
  | 'generated'
  | 'loaded'
  | 'migrated-from-cli'
  | 'unavailable'
  | 'undecryptable'

export interface PassphraseResult {
  ok: boolean
  /** `safeStorage.isEncryptionAvailable()`. */
  encryptionAvailable: boolean
  source: PassphraseSource
  /** Where the sealed passphrase lives — path only, never its contents. */
  passphraseFilePath: string
  error?: string
}

export class PassphraseCustody {
  private readonly filePath: string

  constructor(userDataDir: string, private readonly safeStorage: SafeStorageLike) {
    this.filePath = join(userDataDir, PASSPHRASE_FILENAME)
  }

  /**
   * True once a passphrase has been sealed here, however it got there
   * (freshly generated or migrated from the CLI). Callers use this —
   * combined with whether the configured `plaid_db` already exists on disk —
   * to decide whether the one-time CLI-migration prompt is still relevant.
   * See `computeMigrationStatus` in `src/main/index.ts`.
   */
  hasCustodyFile(): boolean {
    return sealedFileExists(this.filePath)
  }

  /**
   * Read-only decrypt check: does a sealed passphrase file exist, and can it
   * actually be opened right now? Never writes and never generates —
   * unlike `getOrCreate()`, which would happily fabricate a fresh
   * passphrase if no file exists yet. `computeMigrationStatus` in
   * `index.ts` uses this (not `getOrCreate()`) to detect the finding-3
   * "stale ciphertext" case without risking a spurious fresh-passphrase
   * generation as a side effect of merely checking.
   */
  probeCustody(): 'absent' | 'ok' | 'undecryptable' {
    if (!this.hasCustodyFile()) return 'absent'
    try {
      readSealed(this.filePath, this.safeStorage)
      return 'ok'
    } catch {
      return 'undecryptable'
    }
  }

  /**
   * Loads the sealed passphrase if one exists, else generates and seals a
   * fresh random one. Safe to call unconditionally on a brand-new machine
   * (no pre-existing CLI store) — but callers MUST check
   * `hasCustodyFile()` + "does `plaid_db` already exist on disk" BEFORE
   * calling this on every launch, and route to `adoptPassphrase` instead
   * when a pre-existing CLI store is detected. Blindly generating a random
   * passphrase against an already-initialized store wouldn't corrupt
   * anything (`SqliteTokenStore` just throws `TokenStoreKeyError` on the
   * next open attempt — AES-GCM fails closed), but it would silently and
   * permanently orphan the user's existing linked accounts behind a
   * passphrase they never chose and can't recover.
   */
  getOrCreate(): { passphrase: string | null; result: PassphraseResult } {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return {
        passphrase: null,
        result: {
          ok: false,
          encryptionAvailable: false,
          source: 'unavailable',
          passphraseFilePath: this.filePath,
          error: 'OS-level encryption (Keychain / DPAPI / libsecret) is not available on this machine.',
        },
      }
    }

    if (this.hasCustodyFile()) {
      try {
        const existing = readSealed(this.filePath, this.safeStorage)
        if (existing !== null) {
          return {
            passphrase: existing,
            result: { ok: true, encryptionAvailable: true, source: 'loaded', passphraseFilePath: this.filePath },
          }
        }
        // File vanished between the exists check and the read (rare race)
        // — fall through to generate a fresh one below, same as if it had
        // never existed.
      } catch {
        // Sealed file exists but this OS keychain can no longer open it —
        // see the `PassphraseSource` doc comment above. Deliberately does
        // NOT fall through to generating a fresh passphrase: that would
        // silently and permanently orphan whatever token-store data is
        // encrypted under the lost one. No raw OS error text crosses this
        // boundary (IPC discipline — see index.ts / shared/ipc.ts).
        return {
          passphrase: null,
          result: {
            ok: false,
            encryptionAvailable: true,
            source: 'undecryptable',
            passphraseFilePath: this.filePath,
            error: 'The stored passphrase could not be unlocked by this OS keychain.',
          },
        }
      }
    }

    try {
      const passphrase = randomBytes(32).toString('base64')
      writeSealed(this.filePath, passphrase, this.safeStorage)
      return {
        passphrase,
        result: { ok: true, encryptionAvailable: true, source: 'generated', passphraseFilePath: this.filePath },
      }
    } catch (err) {
      return {
        passphrase: null,
        result: {
          ok: false,
          encryptionAvailable: true,
          source: 'unavailable',
          passphraseFilePath: this.filePath,
          error: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  /**
   * Migration path: seals an already-verified CLI passphrase (see
   * `verifyCliPassphrase` below — callers must verify before calling this)
   * instead of generating a random one, so the desktop app opens the SAME
   * token-store database the CLI created, under the SAME passphrase, from
   * here on. Chosen over re-encrypting the database under a new random
   * passphrase because: (1) it keeps the CLI able to open the same store
   * with the same `CLAD_TOKEN_PASSPHRASE` the user already knows — genuine
   * interop, not just directory-sharing; (2) it touches zero existing
   * ciphertext, so there's no re-encryption failure mode partway through;
   * (3) a random, never-displayed passphrase is only meaningful for a store
   * the desktop app originated — for one the CLI originated, the CLI's
   * passphrase already *is* the source of truth.
   */
  adoptPassphrase(passphrase: string): PassphraseResult {
    try {
      writeSealed(this.filePath, passphrase, this.safeStorage)
      return { ok: true, encryptionAvailable: true, source: 'migrated-from-cli', passphraseFilePath: this.filePath }
    } catch (err) {
      return {
        ok: false,
        encryptionAvailable: true,
        source: 'unavailable',
        passphraseFilePath: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * "Start fresh instead" escape hatch, for a user migrating who doesn't
   * know/remember their CLI passphrase. Discards any sealed passphrase here
   * and reseals a brand-new random one. Deliberately never touches the
   * `plaid_db` file itself — callers MUST pair this with repointing
   * `plaid_db` at a new path (`desktopOnlyPlaidDbPath()` in `config.ts`) so
   * the old CLI-managed store is left completely untouched and still usable
   * from the CLI; the desktop app simply starts a new, separate store.
   */
  resetToFreshRandom(): { passphrase: string | null; result: PassphraseResult } {
    deleteSealed(this.filePath)
    return this.getOrCreate()
  }
}

/**
 * Attempts to open `dbPath` (the CLI's existing token store) with a
 * candidate passphrase, without keeping it open — this is a verification
 * check only, run before `PassphraseCustody.adoptPassphrase` seals the
 * candidate. Distinguishes "wrong passphrase" (`TokenStoreKeyError`, a
 * fixed, secret-free message) from any other failure (redacted
 * defensively, same discipline as `token-store.ts`).
 */
export async function verifyCliPassphrase(
  dbPath: string,
  passphrase: string
): Promise<{ ok: boolean; error?: string }> {
  const { SqliteTokenStore, TokenStoreKeyError } = await getCladPlaidAdapter()
  let store: InstanceType<typeof SqliteTokenStore> | undefined
  try {
    store = new SqliteTokenStore({ dbPath, passphrase })
    return { ok: true }
  } catch (err) {
    if (err instanceof TokenStoreKeyError) {
      return { ok: false, error: 'That passphrase does not match this token store.' }
    }
    const { redactSecrets } = await getCladCore()
    return { ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) }
  } finally {
    store?.close()
  }
}
