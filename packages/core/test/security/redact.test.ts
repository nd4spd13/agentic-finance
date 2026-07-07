import { describe, it, expect } from 'vitest'

describe('redactSecrets', () => {
  it('redacts a Plaid access token in a plain string', async () => {
    const { redactSecrets } = await import('../../src/security/redact.js')

    const input = 'Failed to exchange token access-sandbox-1234abcd-5678-efgh-90ij'
    const output = redactSecrets(input)

    expect(output).not.toContain('access-sandbox-1234abcd-5678-efgh-90ij')
    expect(output).toContain('[REDACTED]')
  })

  it('redacts access tokens across sandbox, development, and production environments', async () => {
    const { redactSecrets } = await import('../../src/security/redact.js')

    for (const env of ['sandbox', 'development', 'production']) {
      const token = `access-${env}-abc123-def456`
      const output = redactSecrets(`token=${token}`)
      expect(output).not.toContain(token)
      expect(output).toContain('[REDACTED]')
    }
  })

  it('redacts public tokens', async () => {
    const { redactSecrets } = await import('../../src/security/redact.js')

    const token = 'public-sandbox-aaaa1111-bbbb-2222'
    const output = redactSecrets(`public_token: ${token}`)

    expect(output).not.toContain(token)
    expect(output).toContain('[REDACTED]')
  })

  it('redacts link tokens', async () => {
    const { redactSecrets } = await import('../../src/security/redact.js')

    const token = 'link-production-zzzz9999-yyyy-8888'
    const output = redactSecrets(`link_token: ${token}`)

    expect(output).not.toContain(token)
    expect(output).toContain('[REDACTED]')
  })

  it('redacts a token embedded inside a JSON.stringify-ed error object', async () => {
    const { redactSecrets } = await import('../../src/security/redact.js')

    const err = {
      message: 'Unable to refresh item',
      access_token: 'access-development-9f8e7d6c-5b4a-3210',
    }
    const serialized = JSON.stringify(err)
    const output = redactSecrets(serialized)

    expect(output).not.toContain('access-development-9f8e7d6c-5b4a-3210')
    expect(output).toContain('[REDACTED]')
    // Structure survives redaction (still valid JSON)
    expect(() => JSON.parse(output)).not.toThrow()
  })

  it('redacts secret-like JSON field values (e.g. PLAID_SECRET) even without a token pattern match', async () => {
    const { redactSecrets } = await import('../../src/security/redact.js')

    const serialized = JSON.stringify({
      request: { headers: { 'PLAID-SECRET': 'super-secret-value-xyz' } },
    })
    const output = redactSecrets(serialized)

    expect(output).not.toContain('super-secret-value-xyz')
    expect(output).toContain('[REDACTED]')
  })

  it('redacts a token nested inside an axios-style error message with request/response details', async () => {
    const { redactSecrets } = await import('../../src/security/redact.js')

    const axiosLikeError = {
      message: 'Request failed with status code 400',
      config: {
        url: 'https://sandbox.plaid.com/item/public_token/exchange',
        data: JSON.stringify({
          client_id: 'client123',
          secret: 'shhh-do-not-log-me',
          public_token: 'public-sandbox-1111-2222-3333',
        }),
        headers: {
          'PLAID-SECRET': 'shhh-do-not-log-me',
        },
      },
      response: {
        data: {
          access_token: 'access-sandbox-nested-token-value',
        },
      },
    }
    const nestedMessage = `AxiosError: ${JSON.stringify(axiosLikeError)}`
    const output = redactSecrets(nestedMessage)

    expect(output).not.toContain('public-sandbox-1111-2222-3333')
    expect(output).not.toContain('access-sandbox-nested-token-value')
    expect(output).not.toContain('shhh-do-not-log-me')
    expect(output).toContain('[REDACTED]')
  })

  it('leaves ordinary strings without secrets untouched', async () => {
    const { redactSecrets } = await import('../../src/security/redact.js')

    const input = 'Account acc_checking_001 balance is $3247.89'
    const output = redactSecrets(input)

    expect(output).toBe(input)
  })

  it('handles empty strings', async () => {
    const { redactSecrets } = await import('../../src/security/redact.js')

    expect(redactSecrets('')).toBe('')
  })
})
