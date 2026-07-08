import { describe, expect, it } from 'vitest'
import { SimpleFinClaimError, SimpleFinError, SimpleFinTokenError } from '../src/errors.js'

describe('SimpleFinError', () => {
  it('defaults to a generic local code and sets name/message', () => {
    const error = new SimpleFinError('something went wrong')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('SimpleFinError')
    expect(error.code).toBe('local.simplefin_error')
    expect(error.message).toBe('something went wrong')
  })

  it('accepts an explicit code', () => {
    const error = new SimpleFinError('boom', { code: 'con.auth' })
    expect(error.code).toBe('con.auth')
  })

  it('redacts secret-shaped substrings defensively', () => {
    // redactSecrets targets Plaid-style tokens and `"field": "value"` pairs
    // whose field name looks secret-like; this exercises that path so a
    // future subclass that forwards an upstream error string still gets the
    // same defense-in-depth as plaid-adapter's LinkFlowError.
    const error = new SimpleFinError('upstream said: "access_token": "super-secret-value"')
    expect(error.message).not.toContain('super-secret-value')
    expect(error.message).toContain('[REDACTED]')
  })
})

describe('SimpleFinTokenError', () => {
  it('is a SimpleFinError with the invalid-setup-token code', () => {
    const error = new SimpleFinTokenError('bad token')
    expect(error).toBeInstanceOf(SimpleFinError)
    expect(error).toBeInstanceOf(SimpleFinTokenError)
    expect(error.name).toBe('SimpleFinTokenError')
    expect(error.code).toBe('local.invalid_setup_token')
  })
})

describe('SimpleFinClaimError', () => {
  it('is a SimpleFinError with the claim-failed code', () => {
    const error = new SimpleFinClaimError('claim failed')
    expect(error).toBeInstanceOf(SimpleFinError)
    expect(error).toBeInstanceOf(SimpleFinClaimError)
    expect(error.name).toBe('SimpleFinClaimError')
    expect(error.code).toBe('local.claim_failed')
  })
})
