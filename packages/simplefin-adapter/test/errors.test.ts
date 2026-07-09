import { describe, expect, it } from 'vitest'
import {
  SimpleFinAccessTokenError,
  SimpleFinAccountError,
  SimpleFinClaimError,
  SimpleFinConnectionError,
  SimpleFinError,
  SimpleFinGeneralError,
  SimpleFinHttpError,
  SimpleFinNetworkError,
  SimpleFinProtocolError,
  SimpleFinRequestError,
  SimpleFinResponseError,
  SimpleFinSubscriptionError,
  SimpleFinTokenError,
} from '../src/errors.js'

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

// ---------------------------------------------------------------------
// SF3: client.ts error hierarchy
// ---------------------------------------------------------------------

describe('SimpleFinRequestError', () => {
  it('is a SimpleFinError with the invalid-request code', () => {
    const error = new SimpleFinRequestError('bad request shape')
    expect(error).toBeInstanceOf(SimpleFinError)
    expect(error).toBeInstanceOf(SimpleFinRequestError)
    expect(error.name).toBe('SimpleFinRequestError')
    expect(error.code).toBe('local.invalid_request')
  })
})

describe('SimpleFinNetworkError', () => {
  it('is a SimpleFinError with the network-error code', () => {
    const error = new SimpleFinNetworkError('could not reach the Bridge')
    expect(error).toBeInstanceOf(SimpleFinError)
    expect(error).toBeInstanceOf(SimpleFinNetworkError)
    expect(error.name).toBe('SimpleFinNetworkError')
    expect(error.code).toBe('local.network_error')
  })
})

describe('SimpleFinResponseError', () => {
  it('is a SimpleFinError with the invalid-response code', () => {
    const error = new SimpleFinResponseError('body was not valid JSON')
    expect(error).toBeInstanceOf(SimpleFinError)
    expect(error).toBeInstanceOf(SimpleFinResponseError)
    expect(error.name).toBe('SimpleFinResponseError')
    expect(error.code).toBe('local.invalid_response')
  })
})

describe('SimpleFinHttpError', () => {
  it('carries the HTTP status and a default http.<status> code', () => {
    const error = new SimpleFinHttpError('request failed', 500)
    expect(error).toBeInstanceOf(SimpleFinError)
    expect(error.name).toBe('SimpleFinHttpError')
    expect(error.status).toBe(500)
    expect(error.code).toBe('http.500')
  })

  it('accepts an explicit code override', () => {
    const error = new SimpleFinHttpError('request failed', 418, 'http.teapot')
    expect(error.code).toBe('http.teapot')
  })
})

describe('SimpleFinSubscriptionError (HTTP 402)', () => {
  it('is a SimpleFinHttpError with status 402 and code http.402', () => {
    const error = new SimpleFinSubscriptionError('subscription lapsed')
    expect(error).toBeInstanceOf(SimpleFinError)
    expect(error).toBeInstanceOf(SimpleFinHttpError)
    expect(error).toBeInstanceOf(SimpleFinSubscriptionError)
    expect(error.name).toBe('SimpleFinSubscriptionError')
    expect(error.status).toBe(402)
    expect(error.code).toBe('http.402')
  })
})

describe('SimpleFinAccessTokenError (HTTP 403)', () => {
  it('is a SimpleFinHttpError with status 403 and code http.403', () => {
    const error = new SimpleFinAccessTokenError('token invalid or compromised')
    expect(error).toBeInstanceOf(SimpleFinError)
    expect(error).toBeInstanceOf(SimpleFinHttpError)
    expect(error).toBeInstanceOf(SimpleFinAccessTokenError)
    expect(error.name).toBe('SimpleFinAccessTokenError')
    expect(error.status).toBe(403)
    expect(error.code).toBe('http.403')
  })
})

describe('SimpleFinProtocolError and its gen./con./act. subclasses', () => {
  it('SimpleFinProtocolError carries the code as subcode too', () => {
    const error = new SimpleFinProtocolError('something happened', 'gen.unspecified')
    expect(error).toBeInstanceOf(SimpleFinError)
    expect(error.name).toBe('SimpleFinProtocolError')
    expect(error.code).toBe('gen.unspecified')
    expect(error.subcode).toBe('gen.unspecified')
  })

  it('SimpleFinGeneralError is a SimpleFinProtocolError', () => {
    const error = new SimpleFinGeneralError('general issue', 'gen.rate_limited')
    expect(error).toBeInstanceOf(SimpleFinProtocolError)
    expect(error).toBeInstanceOf(SimpleFinGeneralError)
    expect(error.name).toBe('SimpleFinGeneralError')
    expect(error.code).toBe('gen.rate_limited')
  })

  it('SimpleFinConnectionError is a SimpleFinProtocolError', () => {
    const error = new SimpleFinConnectionError('connection issue', 'con.auth')
    expect(error).toBeInstanceOf(SimpleFinProtocolError)
    expect(error).toBeInstanceOf(SimpleFinConnectionError)
    expect(error.name).toBe('SimpleFinConnectionError')
    expect(error.code).toBe('con.auth')
  })

  it('SimpleFinAccountError is a SimpleFinProtocolError', () => {
    const error = new SimpleFinAccountError('account issue', 'act.closed')
    expect(error).toBeInstanceOf(SimpleFinProtocolError)
    expect(error).toBeInstanceOf(SimpleFinAccountError)
    expect(error.name).toBe('SimpleFinAccountError')
    expect(error.code).toBe('act.closed')
  })

  it('an unrecognized subcode under a known prefix still redacts secrets defensively', () => {
    const error = new SimpleFinConnectionError(
      'upstream said: "access_token": "super-secret-value"',
      'con.some-new-subcode'
    )
    expect(error.message).not.toContain('super-secret-value')
    expect(error.code).toBe('con.some-new-subcode')
  })
})
