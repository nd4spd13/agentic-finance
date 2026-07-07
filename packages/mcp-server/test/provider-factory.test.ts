import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DummyDataProvider } from '@clad/core'

const PLAID_ENV_KEYS = ['CLAD_PROVIDER', 'PLAID_CLIENT_ID', 'PLAID_SECRET', 'CLAD_TOKEN_PASSPHRASE'] as const

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
      /PLAID_CLIENT_ID.*PLAID_SECRET.*CLAD_TOKEN_PASSPHRASE/s
    )
  })

  it('throws naming only the specific missing credential(s)', async () => {
    process.env.CLAD_PROVIDER = 'plaid'
    process.env.PLAID_CLIENT_ID = 'test-client-id'
    process.env.PLAID_SECRET = 'test-secret'
    // CLAD_TOKEN_PASSPHRASE intentionally left unset
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(/CLAD_TOKEN_PASSPHRASE/)
    await expect(createProvider()).rejects.not.toThrow(/PLAID_CLIENT_ID/)
  })

  it('fails with a not-yet-implemented error when plaid credentials are all present', async () => {
    process.env.CLAD_PROVIDER = 'plaid'
    process.env.PLAID_CLIENT_ID = 'test-client-id'
    process.env.PLAID_SECRET = 'test-secret'
    process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
    const { createProvider } = await import('../src/provider-factory.js')
    // WP3 (token store) and WP4 (link flow) don't exist yet, so this branch
    // cannot construct a working PlaidAdapter. It must fail clearly rather
    // than silently falling back to the dummy provider.
    await expect(createProvider()).rejects.toThrow(/not yet implemented/i)
  })

  it('rejects an unknown CLAD_PROVIDER value', async () => {
    process.env.CLAD_PROVIDER = 'bogus'
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(/Unknown CLAD_PROVIDER/)
  })
})
