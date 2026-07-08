/**
 * S0.3 spike — first-launch passphrase custody via Electron `safeStorage`.
 *
 * Flow: first launch generates a random high-entropy passphrase, encrypts it
 * with `safeStorage.encryptString` (Keychain-backed on macOS, DPAPI on
 * Windows, libsecret on Linux), and writes the ciphertext to
 * `<userData>/passphrase.bin` (0600). On every subsequent launch, the
 * ciphertext is read back and decrypted — no user interaction, no
 * memorized passphrase. This replaces the CLI's `CLAD_TOKEN_PASSPHRASE`
 * env var / user-memorized-passphrase model.
 *
 * The passphrase itself is returned to the caller (main-process only, e.g.
 * to open a real token store) alongside a display-safe result object. The
 * IPC layer must forward only `PassphraseCustodySpikeResult` — never the
 * passphrase — to the renderer (desktop-app.md security checklist item 1).
 */

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { getCladCore } from '../lib/clad-core.js'
import type { PassphraseCustodySpikeResult } from '../../shared/ipc.js'

const PASSPHRASE_FILENAME = 'passphrase.bin'
/** 0600 — owner read/write only, mirroring `token-store.ts`'s FILE_MODE discipline. */
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

export interface PassphraseCustodyOutcome {
  /** The plaintext passphrase — main-process use only. Never send over IPC. */
  passphrase: string | null
  result: PassphraseCustodySpikeResult
}

export async function runPassphraseCustodySpike(): Promise<PassphraseCustodyOutcome> {
  const userDataDir = app.getPath('userData')
  const passphraseFilePath = join(userDataDir, PASSPHRASE_FILENAME)

  if (!safeStorage.isEncryptionAvailable()) {
    return {
      passphrase: null,
      result: {
        ok: false,
        encryptionAvailable: false,
        source: 'unavailable',
        passphraseFilePath,
        error:
          'OS-level encryption (Keychain / DPAPI / libsecret) is not available on this machine.',
      },
    }
  }

  try {
    if (existsSync(passphraseFilePath)) {
      const ciphertext = readFileSync(passphraseFilePath)
      const passphrase = safeStorage.decryptString(ciphertext)
      enforceFileMode(passphraseFilePath)
      return {
        passphrase,
        result: {
          ok: true,
          encryptionAvailable: true,
          source: 'loaded',
          passphraseFilePath,
        },
      }
    }

    const passphrase = randomBytes(32).toString('base64')
    const ciphertext = safeStorage.encryptString(passphrase)
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(passphraseFilePath, ciphertext)
    enforceFileMode(passphraseFilePath)

    return {
      passphrase,
      result: {
        ok: true,
        encryptionAvailable: true,
        source: 'generated',
        passphraseFilePath,
      },
    }
  } catch (err) {
    const { redactSecrets } = await getCladCore()
    return {
      passphrase: null,
      result: {
        ok: false,
        encryptionAvailable: true,
        source: 'unavailable',
        passphraseFilePath,
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      },
    }
  }
}
