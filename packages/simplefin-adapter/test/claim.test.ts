import { describe, expect, it } from 'vitest'
import { claimSetupToken, decodeSetupToken, type FetchLike } from '../src/claim.js'
import { SimpleFinClaimError, SimpleFinTokenError } from '../src/errors.js'

/**
 * A representative (fake) access URL. Per the plan's security invariant, the
 * access URL — and especially its embedded basic-auth userinfo — must never
 * appear in a thrown error message. Several tests below assert exactly that.
 */
const FAKE_ACCESS_URL = 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/abc123'
const FAKE_USERINFO = 'sfin-user:sfin-p4ss'
const FAKE_CLAIM_URL = 'https://bridge.example.org/simplefin/claim/one-time-token-xyz'

function encodeSetupToken(url: string): string {
  return Buffer.from(url, 'utf-8').toString('base64')
}

interface RecordedCall {
  url: string
  method?: string
  headers: Record<string, string>
  body?: unknown
}

/**
 * Builds a fake `fetch` that returns each provided response factory in
 * order (the last one repeats if `fetch` is called more times than there
 * are factories), recording every call so tests can assert on request
 * method/headers/body. Never touches the network.
 */
function makeFakeFetch(factories: Array<() => Response | Promise<Response>>): {
  fetch: FetchLike
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let index = 0

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
    }
    calls.push({ url: String(input), method: init?.method, headers, body: init?.body })

    const factory = factories[Math.min(index, factories.length - 1)]
    index += 1
    return factory()
  }) as FetchLike

  return { fetch: fetchImpl, calls }
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200, statusText: 'OK' })
}

function errorResponse(status: number, statusText: string, body = ''): Response {
  return new Response(body, { status, statusText })
}

function assertNoAccessUrl(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  expect(serialized).not.toContain(FAKE_ACCESS_URL)
  expect(serialized).not.toContain(FAKE_USERINFO)
}

describe('decodeSetupToken', () => {
  it('decodes a base64-encoded claim URL', () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    expect(decodeSetupToken(token)).toBe(FAKE_CLAIM_URL)
  })

  it('tolerates surrounding whitespace (e.g. a trailing newline from copy-paste)', () => {
    const token = `  ${encodeSetupToken(FAKE_CLAIM_URL)}\n`
    expect(decodeSetupToken(token)).toBe(FAKE_CLAIM_URL)
  })

  it('throws SimpleFinTokenError for an empty token', () => {
    expect(() => decodeSetupToken('')).toThrow(SimpleFinTokenError)
    expect(() => decodeSetupToken('   ')).toThrow(SimpleFinTokenError)
  })

  it('throws SimpleFinTokenError for a token that is not valid base64', () => {
    // `!` and whitespace are outside the base64 alphabet.
    expect(() => decodeSetupToken('not-valid-base64!! ')).toThrow(SimpleFinTokenError)
  })

  it('throws SimpleFinTokenError when the decoded bytes are not a URL', () => {
    const token = encodeSetupToken('this is not a url')
    expect(() => decodeSetupToken(token)).toThrow(SimpleFinTokenError)
  })

  it('throws SimpleFinTokenError when the decoded URL uses a non-http(s) scheme', () => {
    const token = encodeSetupToken('ftp://bridge.example.org/simplefin/claim/xyz')
    expect(() => decodeSetupToken(token)).toThrow(SimpleFinTokenError)
  })

  it('error messages never contain a decoded credential-shaped URL', () => {
    const token = encodeSetupToken('not a url but happens to mention ' + FAKE_ACCESS_URL)
    try {
      decodeSetupToken(token)
      expect.unreachable('expected decodeSetupToken to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SimpleFinTokenError)
      assertNoAccessUrl((error as Error).message)
    }
  })
})

describe('claimSetupToken', () => {
  it('POSTs to the decoded claim URL with Content-Length: 0 and an empty body', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch, calls } = makeFakeFetch([() => okResponse(FAKE_ACCESS_URL)])

    const accessUrl = await claimSetupToken(token, { fetch })

    expect(accessUrl).toBe(FAKE_ACCESS_URL)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(FAKE_CLAIM_URL)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['content-length']).toBe('0')
    expect(calls[0].body).toBe('')
  })

  it('trims whitespace from the claimed access URL', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([() => okResponse(`  ${FAKE_ACCESS_URL}\n`)])

    await expect(claimSetupToken(token, { fetch })).resolves.toBe(FAKE_ACCESS_URL)
  })

  it('never calls fetch for a malformed setup token', async () => {
    const { fetch, calls } = makeFakeFetch([() => okResponse(FAKE_ACCESS_URL)])

    await expect(claimSetupToken('!!not base64!!', { fetch })).rejects.toBeInstanceOf(
      SimpleFinTokenError
    )
    expect(calls).toHaveLength(0)
  })

  it('throws SimpleFinClaimError on a non-2xx response (e.g. the token was already claimed)', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([() => errorResponse(403, 'Forbidden')])

    const promise = claimSetupToken(token, { fetch })
    await expect(promise).rejects.toBeInstanceOf(SimpleFinClaimError)
    await promise.catch((error: Error) => {
      expect(error.message).toContain('403')
      expect(error.message).toContain('one-time use')
      assertNoAccessUrl(error.message)
    })
  })

  it('models one-time reuse: a second claim of the same token fails', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch, calls } = makeFakeFetch([
      () => okResponse(FAKE_ACCESS_URL),
      () => errorResponse(403, 'Forbidden'),
    ])

    const first = await claimSetupToken(token, { fetch })
    expect(first).toBe(FAKE_ACCESS_URL)

    await expect(claimSetupToken(token, { fetch })).rejects.toBeInstanceOf(SimpleFinClaimError)
    expect(calls).toHaveLength(2)
  })

  it('throws SimpleFinClaimError when the response body is empty', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([() => okResponse('')])

    await expect(claimSetupToken(token, { fetch })).rejects.toBeInstanceOf(SimpleFinClaimError)
  })

  it('throws SimpleFinClaimError when the response body is not a valid URL', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([() => okResponse('this is not a url')])

    await expect(claimSetupToken(token, { fetch })).rejects.toBeInstanceOf(SimpleFinClaimError)
  })

  it('throws SimpleFinClaimError when the response body uses a non-http(s) scheme', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([() => okResponse('ftp://bridge.example.org/access/abc')])

    await expect(claimSetupToken(token, { fetch })).rejects.toBeInstanceOf(SimpleFinClaimError)
  })

  it('throws SimpleFinClaimError (no leaked detail) when the network request itself fails', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED ${FAKE_ACCESS_URL}`)
    }) as FetchLike

    const promise = claimSetupToken(token, { fetch: fetchImpl })
    await expect(promise).rejects.toBeInstanceOf(SimpleFinClaimError)
    await promise.catch((error: Error) => {
      assertNoAccessUrl(error.message)
    })
  })

  it('rejects when no fetch is available and none was injected', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const originalFetch = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).fetch = undefined
    try {
      await expect(claimSetupToken(token)).rejects.toBeInstanceOf(SimpleFinClaimError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('never leaks the access URL or its embedded credentials in any thrown message', async () => {
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const scenarios: Array<() => Response> = [
      () => errorResponse(403, 'Forbidden', `already claimed by ${FAKE_ACCESS_URL}`),
      () => okResponse(''),
      () => okResponse('not-a-url'),
    ]

    for (const scenario of scenarios) {
      const { fetch } = makeFakeFetch([scenario])
      await claimSetupToken(token, { fetch }).catch((error: Error) => {
        assertNoAccessUrl(error.message)
      })
    }
  })
})
