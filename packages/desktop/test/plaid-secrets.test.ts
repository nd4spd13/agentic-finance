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
})
