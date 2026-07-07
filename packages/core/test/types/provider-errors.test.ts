import { describe, it, expect } from 'vitest'

describe('ProviderUnavailableError', () => {
  it('extends Error and carries a code', async () => {
    const { ProviderUnavailableError } = await import('../../src/types/provider-errors.js')

    const err = new ProviderUnavailableError('Plaid is unreachable and no cache exists')

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ProviderUnavailableError)
    expect(err.code).toBe('PROVIDER_UNAVAILABLE')
    expect(err.message).toBe('Plaid is unreachable and no cache exists')
    expect(err.name).toBe('ProviderUnavailableError')
  })
})

describe('ProviderAuthError', () => {
  it('extends Error, carries a code and item_id, never token material', async () => {
    const { ProviderAuthError } = await import('../../src/types/provider-errors.js')

    const err = new ProviderAuthError('Item login required', 'item-abc-123')

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ProviderAuthError)
    expect(err.code).toBe('PROVIDER_AUTH_ERROR')
    expect(err.item_id).toBe('item-abc-123')
    expect(err.message).toBe('Item login required')
    expect(err.name).toBe('ProviderAuthError')
  })

  it('never exposes token material through its own fields', async () => {
    const { ProviderAuthError } = await import('../../src/types/provider-errors.js')

    const err = new ProviderAuthError('Item login required', 'item-abc-123')
    const ownKeys = Object.keys(err)

    expect(ownKeys).not.toContain('access_token')
    expect(ownKeys).not.toContain('accessToken')
    expect(ownKeys).not.toContain('token')
  })
})
