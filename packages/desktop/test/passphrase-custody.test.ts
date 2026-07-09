/**
 * `PassphraseCustody` is DI'd with a `SafeStorageLike` (see `sealed-file.ts`)
 * specifically so its branching — generate vs. load vs. migrate vs. reset —
 * is testable without a live Electron process. `verifyCliPassphrase` is
 * exercised against a real `SqliteTokenStore` (via the `node:sqlite` shim —
 * see `vitest.config.ts`), since that's the one part of this module that
 * genuinely needs `@clad/plaid-adapter`'s real crypto.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteTokenStore } from '@clad/plaid-adapter'
import { PassphraseCustody, verifyCliPassphrase } from '../src/main/lib/passphrase.js'
import type { SafeStorageLike } from '../src/main/lib/sealed-file.js'

class FakeSafeStorage implements SafeStorageLike {
  available = true
  isEncryptionAvailable(): boolean {
    return this.available
  }
  encryptString(plainText: string): Buffer {
    return Buffer.from(`FAKE:${plainText}`, 'utf-8')
  }
  decryptString(encrypted: Buffer): string {
    const text = encrypted.toString('utf-8')
    if (!text.startsWith('FAKE:')) throw new Error('bad ciphertext')
    return text.slice('FAKE:'.length)
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-desktop-passphrase-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('PassphraseCustody', () => {
  it('getOrCreate generates a fresh passphrase and seals it at 0600 on first call', () => {
    const custody = new PassphraseCustody(dir, new FakeSafeStorage())
    expect(custody.hasCustodyFile()).toBe(false)

    const { passphrase, result } = custody.getOrCreate()

    expect(result.ok).toBe(true)
    expect(result.source).toBe('generated')
    expect(passphrase).toBeTruthy()
    expect(passphrase!.length).toBeGreaterThan(20)
    expect(custody.hasCustodyFile()).toBe(true)
    const mode = statSync(result.passphraseFilePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('getOrCreate loads the same passphrase on a second call (same or new instance)', () => {
    const safeStorage = new FakeSafeStorage()
    const first = new PassphraseCustody(dir, safeStorage).getOrCreate()

    const second = new PassphraseCustody(dir, safeStorage).getOrCreate()

    expect(second.result.source).toBe('loaded')
    expect(second.passphrase).toBe(first.passphrase)
  })

  it('reports unavailable (and never generates) when safeStorage encryption is unavailable', () => {
    const safeStorage = new FakeSafeStorage()
    safeStorage.available = false
    const custody = new PassphraseCustody(dir, safeStorage)

    const { passphrase, result } = custody.getOrCreate()

    expect(passphrase).toBeNull()
    expect(result.ok).toBe(false)
    expect(result.encryptionAvailable).toBe(false)
    expect(result.source).toBe('unavailable')
    expect(custody.hasCustodyFile()).toBe(false)
  })

  it('adoptPassphrase seals a caller-supplied (CLI) passphrase, retrievable via getOrCreate afterward', () => {
    const safeStorage = new FakeSafeStorage()
    const custody = new PassphraseCustody(dir, safeStorage)

    const adoptResult = custody.adoptPassphrase('my-cli-passphrase')
    expect(adoptResult.ok).toBe(true)
    expect(adoptResult.source).toBe('migrated-from-cli')

    const { passphrase, result } = new PassphraseCustody(dir, safeStorage).getOrCreate()
    expect(passphrase).toBe('my-cli-passphrase')
    expect(result.source).toBe('loaded')
  })

  it('resetToFreshRandom discards the sealed passphrase and generates a different one', () => {
    const safeStorage = new FakeSafeStorage()
    const custody = new PassphraseCustody(dir, safeStorage)
    const original = custody.adoptPassphrase('old-cli-passphrase')
    expect(original.ok).toBe(true)

    const { passphrase, result } = custody.resetToFreshRandom()

    expect(result.source).toBe('generated')
    expect(passphrase).not.toBe('old-cli-passphrase')
  })
})

describe('verifyCliPassphrase', () => {
  let storeDir: string
  let dbPath: string

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'clad-desktop-tokenstore-test-'))
    dbPath = join(storeDir, 'plaid.sqlite')
    // Seed a real token store, exactly as `clad connect` would have.
    const store = new SqliteTokenStore({ dbPath, passphrase: 'correct-horse-battery-staple' })
    store.close()
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  it('succeeds for the correct passphrase', async () => {
    const result = await verifyCliPassphrase(dbPath, 'correct-horse-battery-staple')
    expect(result.ok).toBe(true)
  })

  it('fails, with a secret-free message, for an incorrect passphrase', async () => {
    const result = await verifyCliPassphrase(dbPath, 'wrong-passphrase')
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.error).not.toContain('wrong-passphrase')
    expect(result.error).not.toContain('correct-horse-battery-staple')
  })
})
