import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { deriveKey, encrypt, decrypt } from '../src/crypto.js'

const PASSPHRASE = 'correct horse battery staple'
const SALT = randomBytes(16)

// Derive once and reuse — scrypt with N=2^15 is intentionally slow, so
// deriving per-test would make this suite needlessly sluggish.
const key = deriveKey(PASSPHRASE, SALT)

describe('deriveKey', () => {
  it('produces a 32-byte key (AES-256)', () => {
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
  })

  it('is deterministic for the same passphrase + salt', () => {
    const again = deriveKey(PASSPHRASE, SALT)
    expect(again.equals(key)).toBe(true)
  })

  it('differs when the salt differs', () => {
    const otherSalt = randomBytes(16)
    const otherKey = deriveKey(PASSPHRASE, otherSalt)
    expect(otherKey.equals(key)).toBe(false)
  })

  it('differs when the passphrase differs', () => {
    const otherKey = deriveKey('a different passphrase', SALT)
    expect(otherKey.equals(key)).toBe(false)
  })
})

describe('encrypt / decrypt round-trip', () => {
  it('recovers the original plaintext', () => {
    const plaintext = 'access-sandbox-11111111-2222-3333-4444-555555555555'
    const payload = encrypt(key, plaintext)
    expect(decrypt(key, payload)).toBe(plaintext)
  })

  it('handles empty and unicode plaintext', () => {
    for (const plaintext of ['', 'ünïcödé 🔐 secret', 'x'.repeat(10_000)]) {
      const payload = encrypt(key, plaintext)
      expect(decrypt(key, payload)).toBe(plaintext)
    }
  })

  it('produces a 12-byte IV and a 16-byte auth tag', () => {
    const payload = encrypt(key, 'anything')
    expect(payload.iv.length).toBe(12)
    expect(payload.authTag.length).toBe(16)
  })

  it('never emits the plaintext bytes in the ciphertext', () => {
    const plaintext = 'access-sandbox-abc123'
    const { ciphertext } = encrypt(key, plaintext)
    expect(ciphertext.toString('latin1')).not.toContain(plaintext)
    expect(ciphertext.toString('utf8')).not.toContain(plaintext)
  })
})

describe('IV uniqueness', () => {
  it('uses a fresh random IV on every call', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const { iv } = encrypt(key, 'same plaintext every time')
      seen.add(iv.toString('hex'))
    }
    expect(seen.size).toBe(200)
  })

  it('yields different ciphertext for the same plaintext (semantic security)', () => {
    const a = encrypt(key, 'same plaintext')
    const b = encrypt(key, 'same plaintext')
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
  })
})

describe('tamper detection (GCM integrity)', () => {
  it('rejects a tampered ciphertext', () => {
    const payload = encrypt(key, 'secret value')
    const tampered = Buffer.from(payload.ciphertext)
    tampered[0] ^= 0xff
    expect(() => decrypt(key, { ...payload, ciphertext: tampered })).toThrow()
  })

  it('rejects a tampered auth tag', () => {
    const payload = encrypt(key, 'secret value')
    const tampered = Buffer.from(payload.authTag)
    tampered[0] ^= 0xff
    expect(() => decrypt(key, { ...payload, authTag: tampered })).toThrow()
  })

  it('rejects a tampered IV', () => {
    const payload = encrypt(key, 'secret value')
    const tampered = Buffer.from(payload.iv)
    tampered[0] ^= 0xff
    expect(() => decrypt(key, { ...payload, iv: tampered })).toThrow()
  })

  it('rejects decryption with the wrong key', () => {
    const payload = encrypt(key, 'secret value')
    const wrongKey = deriveKey('totally wrong passphrase', SALT)
    expect(() => decrypt(wrongKey, payload)).toThrow()
  })
})
