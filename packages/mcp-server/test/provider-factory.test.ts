import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DummyDataProvider } from '@clad/core'
import { PlaidAdapter } from '@clad/plaid-adapter'

const PLAID_ENV_KEYS = [
  'CLAD_PROVIDER',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'CLAD_TOKEN_PASSPHRASE',
  'CLAD_PLAID_DB',
] as const

describe('createProvider', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of PLAID_ENV_KEYS) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of PLAID_ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
  })

  it('returns a DummyDataProvider when CLAD_PROVIDER is unset', async () => {
    const { createProvider } = await import('../src/provider-factory.js')
    const provider = await createProvider()
    expect(provider).toBeInstanceOf(DummyDataProvider)
  })

  it('returns a DummyDataProvider when CLAD_PROVIDER=dummy', async () => {
    process.env.CLAD_PROVIDER = 'dummy'
    const { createProvider } = await import('../src/provider-factory.js')
    const provider = await createProvider()
    expect(provider).toBeInstanceOf(DummyDataProvider)
  })

  it('throws naming all missing credentials when CLAD_PROVIDER=plaid and none are set', async () => {
    process.env.CLAD_PROVIDER = 'plaid'
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(
      /PLAID_CLIENT_ID.*PLAID_SECRET.*PLAID_ENV.*CLAD_TOKEN_PASSPHRASE/s
    )
  })

  it('throws naming only the specific missing credential(s)', async () => {
    process.env.CLAD_PROVIDER = 'plaid'
    process.env.PLAID_CLIENT_ID = 'test-client-id'
    process.env.PLAID_SECRET = 'test-secret'
    process.env.PLAID_ENV = 'sandbox'
    // CLAD_TOKEN_PASSPHRASE intentionally left unset
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(/CLAD_TOKEN_PASSPHRASE/)
    await expect(createProvider()).rejects.not.toThrow(/PLAID_CLIENT_ID/)
  })

  it('rejects an unsupported PLAID_ENV value', async () => {
    process.env.CLAD_PROVIDER = 'plaid'
    process.env.PLAID_CLIENT_ID = 'test-client-id'
    process.env.PLAID_SECRET = 'test-secret'
    process.env.PLAID_ENV = 'bogus-env'
    process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(/Unsupported PLAID_ENV "bogus-env"/)
  })

  describe('with full plaid credentials', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'clad-provider-factory-'))
      process.env.CLAD_PROVIDER = 'plaid'
      process.env.PLAID_CLIENT_ID = 'test-client-id'
      process.env.PLAID_SECRET = 'test-secret'
      process.env.PLAID_ENV = 'sandbox'
      process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
      process.env.CLAD_PLAID_DB = join(dir, 'nested', 'plaid.sqlite')
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('constructs a PlaidAdapter at the CLAD_PLAID_DB path (no network access)', async () => {
      const { createProvider } = await import('../src/provider-factory.js')
      const provider = await createProvider()
      expect(provider).toBeInstanceOf(PlaidAdapter)
    })

    it('fails fast with a redacted error on a wrong passphrase', async () => {
      const { createProvider } = await import('../src/provider-factory.js')
      await createProvider() // first open writes the key-check
      process.env.CLAD_TOKEN_PASSPHRASE = 'a-different-passphrase'
      const error = await createProvider().then(
        () => {
          throw new Error('expected createProvider to reject')
        },
        (e: unknown) => e as Error
      )
      expect(error.message).not.toContain('test-passphrase')
      expect(error.message).not.toContain('a-different-passphrase')
    })
  })
})
