import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlaidSecretsStore } from '../src/main/lib/plaid-secrets.js'
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
  dir = mkdtempSync(join(tmpdir(), 'clad-desktop-plaid-secrets-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('PlaidSecretsStore', () => {
  it('has() is false before anything is saved', () => {
    const store = new PlaidSecretsStore(dir, new FakeSafeStorage())
    expect(store.has()).toBe(false)
    expect(store.load()).toBeNull()
  })

  it('save + load roundtrips clientId/secret and seals the file at 0600', () => {
    const store = new PlaidSecretsStore(dir, new FakeSafeStorage())

    const result = store.save({ clientId: 'client-123', secret: 'shh-secret' })

    expect(result.ok).toBe(true)
    expect(store.has()).toBe(true)
    const loaded = store.load()
    expect(loaded).toEqual({ clientId: 'client-123', secret: 'shh-secret' })

    // Locate the sealed file the same way the store does, to check its mode.
    const filePath = join(dir, 'plaid-credentials.bin')
    const mode = statSync(filePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('rejects empty clientId or secret without touching disk', () => {
    const store = new PlaidSecretsStore(dir, new FakeSafeStorage())

    const result = store.save({ clientId: '  ', secret: 'shh-secret' })

    expect(result.ok).toBe(false)
    expect(store.has()).toBe(false)
  })

  it('reports failure (and never fabricates a value) when encryption is unavailable', () => {
    const safeStorage = new FakeSafeStorage()
    safeStorage.available = false
    const store = new PlaidSecretsStore(dir, safeStorage)

    const result = store.save({ clientId: 'client-123', secret: 'shh-secret' })

    expect(result.ok).toBe(false)
    expect(store.has()).toBe(false)
  })

  it('clear() removes the sealed credentials', () => {
    const store = new PlaidSecretsStore(dir, new FakeSafeStorage())
    store.save({ clientId: 'client-123', secret: 'shh-secret' })
    expect(store.has()).toBe(true)

    store.clear()

    expect(store.has()).toBe(false)
    expect(store.load()).toBeNull()
  })

  it('load() returns null (not a throw) for a corrupted sealed file', () => {
    const safeStorage = new FakeSafeStorage()
    const store = new PlaidSecretsStore(dir, safeStorage)
    store.save({ clientId: 'client-123', secret: 'shh-secret' })

    // Corrupt the file by re-sealing something that isn't valid JSON.
    const filePath = join(dir, 'plaid-credentials.bin')
    writeFileSync(filePath, safeStorage.encryptString('not json'))

    expect(store.load()).toBeNull()
  })

  /**
   * Regression tests for D1 manual QA finding 3: `has()` alone can't tell
   * "never set" apart from "sealed file exists but can't be unlocked" (e.g.
   * a packaged, differently code-signed build can't decrypt ciphertext a
   * dev build wrote — macOS Keychain ACLs are tied to the signing identity).
   * `status()` must distinguish all three states so the renderer can show
   * an actionable message instead of a silent, misleading "Not set."
   */
  describe('status()', () => {
    it('is "unset" before anything is saved', () => {
      const store = new PlaidSecretsStore(dir, new FakeSafeStorage())
      expect(store.status()).toBe('unset')
    })

    it('is "set" after a successful save', () => {
      const store = new PlaidSecretsStore(dir, new FakeSafeStorage())
      store.save({ clientId: 'client-123', secret: 'shh-secret' })
      expect(store.status()).toBe('set')
    })

    it('is "undecryptable" when the sealed file exists but decryption itself fails (not just malformed JSON after a successful decrypt)', () => {
      const safeStorage = new FakeSafeStorage()
      const store = new PlaidSecretsStore(dir, safeStorage)
      store.save({ clientId: 'client-123', secret: 'shh-secret' })

      // Overwrite with bytes that FakeSafeStorage.decryptString itself
      // rejects (no 'FAKE:' prefix) — simulates a genuine OS-level decrypt
      // failure, not merely bad content after a successful decrypt.
      const filePath = join(dir, 'plaid-credentials.bin')
      writeFileSync(filePath, Buffer.from('not-sealed-at-all'))

      expect(store.status()).toBe('undecryptable')
      expect(store.load()).toBeNull()
    })

    it('is "undecryptable" when decryption succeeds but the plaintext is not valid credentials JSON', () => {
      const safeStorage = new FakeSafeStorage()
      const store = new PlaidSecretsStore(dir, safeStorage)
      store.save({ clientId: 'client-123', secret: 'shh-secret' })

      const filePath = join(dir, 'plaid-credentials.bin')
      writeFileSync(filePath, safeStorage.encryptString('not json'))

      expect(store.status()).toBe('undecryptable')
    })
  })
})
