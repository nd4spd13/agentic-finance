import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildAccountsRequest,
  fetchAccounts,
  parseAccountSet,
  parseProtocolError,
  type FetchLike,
} from '../src/client.js'
import {
  SimpleFinAccessTokenError,
  SimpleFinAccountError,
  SimpleFinConnectionError,
  SimpleFinGeneralError,
  SimpleFinHttpError,
  SimpleFinNetworkError,
  SimpleFinProtocolError,
  SimpleFinRequestError,
  SimpleFinResponseError,
  SimpleFinSubscriptionError,
} from '../src/errors.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/**
 * A representative (fake) access URL, matching the shape used throughout
 * `test/claim.test.ts`. Per the plan's security invariant, the access URL —
 * and especially its embedded basic-auth userinfo — must never appear in a
 * thrown error message or in the URL this module actually hands to `fetch`.
 */
const FAKE_ACCESS_URL = 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/abc123'
const FAKE_USERINFO = 'sfin-user:sfin-p4ss'

function assertNoAccessUrl(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  expect(serialized).not.toContain(FAKE_ACCESS_URL)
  expect(serialized).not.toContain(FAKE_USERINFO)
}

interface RecordedCall {
  url: string
  method?: string
  headers: Record<string, string>
}

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
    calls.push({ url: String(input), method: init?.method, headers })

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

// ---------------------------------------------------------------------
// buildAccountsRequest — param building, auth, and the 90-day window
// ---------------------------------------------------------------------

describe('buildAccountsRequest', () => {
  it('always requests version=2 with no other params by default', () => {
    const { url } = buildAccountsRequest(FAKE_ACCESS_URL)
    const parsed = new URL(url)
    expect(parsed.searchParams.get('version')).toBe('2')
    expect([...parsed.searchParams.keys()]).toEqual(['version'])
  })

  it('targets {accessUrl}/accounts, preserving the access URL path', () => {
    const { url } = buildAccountsRequest(FAKE_ACCESS_URL)
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/simplefin/access/abc123/accounts')
    expect(parsed.origin).toBe('https://bridge.example.org')
  })

  it('handles an access URL whose path has a trailing slash', () => {
    const { url } = buildAccountsRequest('https://user:pass@bridge.example.org/simplefin/')
    expect(new URL(url).pathname).toBe('/simplefin/accounts')
  })

  it('strips the userinfo from the request URL and moves it into a Basic Authorization header', () => {
    const { url, authorizationHeader } = buildAccountsRequest(FAKE_ACCESS_URL)
    const parsed = new URL(url)
    expect(parsed.username).toBe('')
    expect(parsed.password).toBe('')
    expect(url).not.toContain(FAKE_USERINFO)

    const expectedHeader = `Basic ${Buffer.from('sfin-user:sfin-p4ss', 'utf-8').toString('base64')}`
    expect(authorizationHeader).toBe(expectedHeader)
  })

  it('URL-decodes percent-encoded userinfo before building the Authorization header', () => {
    const { authorizationHeader } = buildAccountsRequest(
      'https://sfin-user:sfin%40p4ss@bridge.example.org/simplefin'
    )
    const expectedHeader = `Basic ${Buffer.from('sfin-user:sfin@p4ss', 'utf-8').toString('base64')}`
    expect(authorizationHeader).toBe(expectedHeader)
  })

  it('sets pending=1 only when pending is true', () => {
    expect(new URL(buildAccountsRequest(FAKE_ACCESS_URL, { pending: true }).url).searchParams.get('pending')).toBe(
      '1'
    )
    expect(
      new URL(buildAccountsRequest(FAKE_ACCESS_URL, { pending: false }).url).searchParams.has('pending')
    ).toBe(false)
    expect(new URL(buildAccountsRequest(FAKE_ACCESS_URL).url).searchParams.has('pending')).toBe(false)
  })

  it('sets balances-only=1 only when balancesOnly is true', () => {
    const { url } = buildAccountsRequest(FAKE_ACCESS_URL, { balancesOnly: true })
    expect(new URL(url).searchParams.get('balances-only')).toBe('1')
    expect(new URL(buildAccountsRequest(FAKE_ACCESS_URL).url).searchParams.has('balances-only')).toBe(false)
  })

  it('repeats account={id} for each requested account id, in order', () => {
    const { url } = buildAccountsRequest(FAKE_ACCESS_URL, {
      accountIds: ['fixture-acct-savings', 'fixture-acct-checking'],
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.getAll('account')).toEqual(['fixture-acct-savings', 'fixture-acct-checking'])
  })

  it('includes start-date/end-date as Unix epoch seconds when given', () => {
    const { url } = buildAccountsRequest(FAKE_ACCESS_URL, { startDate: 1_700_000_000, endDate: 1_700_100_000 })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('start-date')).toBe('1700000000')
    expect(parsed.searchParams.get('end-date')).toBe('1700100000')
  })

  it('allows a start-date with no end-date (open-ended window)', () => {
    const { url } = buildAccountsRequest(FAKE_ACCESS_URL, { startDate: 1_700_000_000 })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('start-date')).toBe('1700000000')
    expect(parsed.searchParams.has('end-date')).toBe(false)
  })

  describe('90-day window enforcement', () => {
    const NINETY_DAYS = 90 * 24 * 60 * 60

    it('allows a window of exactly 90 days (boundary)', () => {
      const startDate = 1_700_000_000
      const endDate = startDate + NINETY_DAYS
      expect(() => buildAccountsRequest(FAKE_ACCESS_URL, { startDate, endDate })).not.toThrow()
    })

    it('rejects a window one second over 90 days', () => {
      const startDate = 1_700_000_000
      const endDate = startDate + NINETY_DAYS + 1
      expect(() => buildAccountsRequest(FAKE_ACCESS_URL, { startDate, endDate })).toThrow(
        SimpleFinRequestError
      )
    })

    it('rejects an end-date before start-date', () => {
      expect(() =>
        buildAccountsRequest(FAKE_ACCESS_URL, { startDate: 1_700_100_000, endDate: 1_700_000_000 })
      ).toThrow(SimpleFinRequestError)
    })

    it('rejects a non-integer or negative date', () => {
      expect(() => buildAccountsRequest(FAKE_ACCESS_URL, { startDate: 1.5, endDate: 2 })).toThrow(
        SimpleFinRequestError
      )
      expect(() => buildAccountsRequest(FAKE_ACCESS_URL, { startDate: -1, endDate: 100 })).toThrow(
        SimpleFinRequestError
      )
    })

    it('never calls fetch when the window is rejected', async () => {
      const { fetch, calls } = makeFakeFetch([() => okResponse('{}')])
      const startDate = 1_700_000_000
      const endDate = startDate + NINETY_DAYS + 1
      await expect(fetchAccounts(FAKE_ACCESS_URL, { fetch, startDate, endDate })).rejects.toBeInstanceOf(
        SimpleFinRequestError
      )
      expect(calls).toHaveLength(0)
    })
  })

  it('throws SimpleFinRequestError for a malformed access URL', () => {
    expect(() => buildAccountsRequest('not a url')).toThrow(SimpleFinRequestError)
  })

  it('throws SimpleFinRequestError for a non-http(s) access URL scheme', () => {
    expect(() => buildAccountsRequest('ftp://user:pass@bridge.example.org/simplefin')).toThrow(
      SimpleFinRequestError
    )
  })

  it('throws SimpleFinRequestError when the access URL has no embedded basic-auth credentials', () => {
    expect(() => buildAccountsRequest('https://bridge.example.org/simplefin')).toThrow(SimpleFinRequestError)
  })
})

// ---------------------------------------------------------------------
// fetchAccounts — happy path against the real SF1 fixtures
// ---------------------------------------------------------------------

describe('fetchAccounts happy path (SF1 fixtures)', () => {
  it('parses accounts-v2-plain.json: accounts, connections, holdings, and x-api-message', async () => {
    const body = loadFixture('accounts-v2-plain.json')
    const { fetch, calls } = makeFakeFetch([() => okResponse(body)])

    const result = await fetchAccounts(FAKE_ACCESS_URL, { fetch })

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].headers.authorization).toMatch(/^Basic /)
    expect(calls[0].url).not.toContain(FAKE_USERINFO)

    expect(result.accounts).toHaveLength(3)
    expect(result.errors).toEqual([])
    expect(result.apiMessages).toEqual([
      "Provide a 'start-date' parameter to receive transactions prior to yesterday",
    ])

    const savings = result.accounts.find((a) => a.id === 'fixture-acct-savings')
    expect(savings).toBeDefined()
    // Amounts/balances stay strings — never parsed to numbers.
    expect(typeof savings?.balance).toBe('string')
    expect(savings?.balance).toBe('114405.51')
    expect(typeof savings?.['available-balance']).toBe('string')
    expect(savings?.['balance-date']).toBe(1783555200)
    expect(savings?.conn_id).toBe('fixture-conn-demo')
    expect(savings?.transactions).toHaveLength(4)
    expect(typeof savings?.transactions[0].amount).toBe('string')
    expect(savings?.transactions[0].payee).toBe("John's Fishin Shack")
    expect(savings?.transactions[0].memo).toBe('JOHNS FISHIN SHACK BAIT')

    // Undocumented holdings[] — present on savings, empty on checking/empty.
    expect(savings?.holdings).toHaveLength(1)
    expect(savings?.holdings[0]).toMatchObject({ id: 'fixture-holding-aapl', symbol: 'AAPL' })
    expect(typeof savings?.holdings[0].market_value).toBe('string')

    const checking = result.accounts.find((a) => a.id === 'fixture-acct-checking')
    expect(checking?.holdings).toEqual([])

    expect(result.connections).toHaveLength(1)
    expect(result.connections[0]).toMatchObject({
      conn_id: 'fixture-conn-demo',
      org_id: 'fixture-org-demo',
      org_name: 'SimpleFIN Bridge',
    })
    // v2 accounts carry no `org` field at all.
    expect(savings).not.toHaveProperty('org')
  })

  it('parses accounts-v2-balances-only.json: transactions/holdings are empty arrays, never omitted', async () => {
    const body = loadFixture('accounts-v2-balances-only.json')
    const { fetch } = makeFakeFetch([() => okResponse(body)])

    const result = await fetchAccounts(FAKE_ACCESS_URL, { fetch, balancesOnly: true })

    expect(result.accounts).toHaveLength(3)
    for (const account of result.accounts) {
      // Key-presence is never used to detect balances-only mode: both keys
      // must exist as (empty) arrays, not be undefined/missing.
      expect(Array.isArray(account.transactions)).toBe(true)
      expect(account.transactions).toEqual([])
      expect(Array.isArray(account.holdings)).toBe(true)
      expect(account.holdings).toEqual([])
    }
    expect(result.errors).toEqual([])
  })

  it('parses accounts-v2-pending-window.json: transactions across a wide window', async () => {
    const body = loadFixture('accounts-v2-pending-window.json')
    const { fetch } = makeFakeFetch([() => okResponse(body)])

    const result = await fetchAccounts(FAKE_ACCESS_URL, {
      fetch,
      pending: true,
      startDate: 1_781_000_000,
      endDate: 1_784_000_000,
    })

    const savings = result.accounts.find((a) => a.id === 'fixture-acct-savings')
    expect(savings?.transactions).toHaveLength(8)
    // None of the captured transactions were pending (see fixtures README) —
    // the field is documented but not fixture-backed; assert it's simply
    // absent rather than assuming a value either way.
    expect(savings?.transactions.every((t) => t.pending === undefined)).toBe(true)
    expect(result.errors).toEqual([])
  })
})

// ---------------------------------------------------------------------
// HTTP-level error mapping (402/403/other)
// ---------------------------------------------------------------------

describe('fetchAccounts HTTP error mapping', () => {
  it('maps HTTP 402 to SimpleFinSubscriptionError', async () => {
    const { fetch } = makeFakeFetch([() => errorResponse(402, 'Payment Required')])
    const promise = fetchAccounts(FAKE_ACCESS_URL, { fetch })
    await expect(promise).rejects.toBeInstanceOf(SimpleFinSubscriptionError)
    await promise.catch((error: SimpleFinSubscriptionError) => {
      expect(error).toBeInstanceOf(SimpleFinHttpError)
      expect(error.code).toBe('http.402')
      expect(error.status).toBe(402)
    })
  })

  it('maps HTTP 403 to SimpleFinAccessTokenError', async () => {
    const { fetch } = makeFakeFetch([() => errorResponse(403, 'Forbidden')])
    const promise = fetchAccounts(FAKE_ACCESS_URL, { fetch })
    await expect(promise).rejects.toBeInstanceOf(SimpleFinAccessTokenError)
    await promise.catch((error: SimpleFinAccessTokenError) => {
      expect(error).toBeInstanceOf(SimpleFinHttpError)
      expect(error.code).toBe('http.403')
      expect(error.status).toBe(403)
    })
  })

  it('maps any other non-2xx status to a generic SimpleFinHttpError', async () => {
    const { fetch } = makeFakeFetch([() => errorResponse(500, 'Internal Server Error')])
    const promise = fetchAccounts(FAKE_ACCESS_URL, { fetch })
    await expect(promise).rejects.toBeInstanceOf(SimpleFinHttpError)
    await promise.catch((error: SimpleFinHttpError) => {
      expect(error.code).toBe('http.500')
      expect(error.status).toBe(500)
      expect(error).not.toBeInstanceOf(SimpleFinSubscriptionError)
      expect(error).not.toBeInstanceOf(SimpleFinAccessTokenError)
    })
  })

  it('throws SimpleFinNetworkError when fetch itself rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as FetchLike
    await expect(fetchAccounts(FAKE_ACCESS_URL, { fetch: fetchImpl })).rejects.toBeInstanceOf(
      SimpleFinNetworkError
    )
  })

  it('throws SimpleFinNetworkError when no fetch implementation is available', async () => {
    const originalFetch = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).fetch = undefined
    try {
      await expect(fetchAccounts(FAKE_ACCESS_URL)).rejects.toBeInstanceOf(SimpleFinNetworkError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws SimpleFinResponseError when a 2xx body is not valid JSON', async () => {
    const { fetch } = makeFakeFetch([() => okResponse('not json')])
    await expect(fetchAccounts(FAKE_ACCESS_URL, { fetch })).rejects.toBeInstanceOf(SimpleFinResponseError)
  })

  it('throws SimpleFinResponseError when a 2xx body is valid JSON but not an object', async () => {
    const { fetch } = makeFakeFetch([() => okResponse('[1, 2, 3]')])
    await expect(fetchAccounts(FAKE_ACCESS_URL, { fetch })).rejects.toBeInstanceOf(SimpleFinResponseError)
  })

  it('throws SimpleFinResponseError when a required field is the wrong type', async () => {
    const { fetch } = makeFakeFetch([
      () => okResponse(JSON.stringify({ errlist: [], accounts: 'not-an-array', connections: [] })),
    ])
    await expect(fetchAccounts(FAKE_ACCESS_URL, { fetch })).rejects.toBeInstanceOf(SimpleFinResponseError)
  })

  it('throws SimpleFinResponseError when an account balance is not a string', async () => {
    const malformed = {
      errlist: [],
      accounts: [
        {
          id: 'a1',
          name: 'Bad Account',
          currency: 'USD',
          balance: 114405.51, // should be a numeric string, not a number
          'available-balance': '114405.51',
          'balance-date': 1783555200,
          transactions: [],
          holdings: [],
          conn_id: 'c1',
        },
      ],
      connections: [{ conn_id: 'c1' }],
    }
    const { fetch } = makeFakeFetch([() => okResponse(JSON.stringify(malformed))])
    await expect(fetchAccounts(FAKE_ACCESS_URL, { fetch })).rejects.toBeInstanceOf(SimpleFinResponseError)
  })
})

// ---------------------------------------------------------------------
// parseAccountSet / parseProtocolError — errlist vs errors, and the
// gen./con./act. hierarchy, including unknown-subcode degradation.
// ---------------------------------------------------------------------

describe('parseProtocolError', () => {
  it('maps a con.* code to SimpleFinConnectionError, preserving the raw subcode', () => {
    const error = parseProtocolError('con.auth: re-auth required')
    expect(error).toBeInstanceOf(SimpleFinProtocolError)
    expect(error).toBeInstanceOf(SimpleFinConnectionError)
    expect(error.code).toBe('con.auth')
    expect(error.subcode).toBe('con.auth')
  })

  it('maps an act.* code to SimpleFinAccountError', () => {
    const error = parseProtocolError('act.closed: account is closed')
    expect(error).toBeInstanceOf(SimpleFinAccountError)
    expect(error.code).toBe('act.closed')
  })

  it('maps a gen.* code to SimpleFinGeneralError', () => {
    const error = parseProtocolError('gen.rate_limited: slow down')
    expect(error).toBeInstanceOf(SimpleFinGeneralError)
    expect(error.code).toBe('gen.rate_limited')
  })

  it('degrades an unrecognized subcode to its known prefix category (con.*)', () => {
    const error = parseProtocolError('con.some-brand-new-subcode-never-documented')
    expect(error).toBeInstanceOf(SimpleFinConnectionError)
    expect(error.code).toBe('con.some-brand-new-subcode-never-documented')
  })

  it('degrades an unrecognized subcode to its known prefix category (act.*)', () => {
    const error = parseProtocolError('act.some-brand-new-subcode-never-documented')
    expect(error).toBeInstanceOf(SimpleFinAccountError)
  })

  it('degrades an entry with no recognizable gen./con./act. prefix to SimpleFinGeneralError with code gen.unspecified', () => {
    const error = parseProtocolError('a plain warning string with no code at all')
    expect(error).toBeInstanceOf(SimpleFinGeneralError)
    expect(error.code).toBe('gen.unspecified')
  })

  it('tolerates a non-string entry (defensively stringifies it)', () => {
    const error = parseProtocolError({ weird: 'shape' })
    expect(error).toBeInstanceOf(SimpleFinProtocolError)
    expect(error.code).toBe('gen.unspecified')
  })

  it('tolerates null/undefined entries', () => {
    expect(parseProtocolError(null)).toBeInstanceOf(SimpleFinGeneralError)
    expect(parseProtocolError(undefined)).toBeInstanceOf(SimpleFinGeneralError)
  })

  it('scrubs a credentialed URL embedded in the raw entry text out of the message', () => {
    const error = parseProtocolError(`con.auth: already claimed via ${FAKE_ACCESS_URL}`)
    assertNoAccessUrl(error.message)
    expect(error.message).toContain('[REDACTED-URL]')
  })
})

describe('parseAccountSet / fetchAccounts — errlist vs errors, hand-written fixtures', () => {
  // The three real SF1 captures all returned an empty `errlist` (see the
  // fixtures README and plan doc: SF1 made only 3 requests and never
  // triggered a protocol warning). These two fixtures are hand-written (not
  // captured) specifically to exercise the gen./con./act. hierarchy and the
  // errlist-vs-errors naming, since no real capture has non-empty error
  // arrays to test against.

  it('error-errlist-mixed.json: parses a mix of known/unknown/unstructured errlist entries without throwing', async () => {
    const body = loadFixture('error-errlist-mixed.json')
    const { fetch } = makeFakeFetch([() => okResponse(body)])

    // A 200 OK response with a non-empty errlist is not automatically fatal
    // (e.g. a rate-limit warning) — fetchAccounts must still resolve with
    // the account data alongside the parsed, typed errors.
    const result = await fetchAccounts(FAKE_ACCESS_URL, { fetch })

    expect(result.accounts).toHaveLength(1)
    expect(result.errors).toHaveLength(4)

    expect(result.errors[0]).toBeInstanceOf(SimpleFinConnectionError)
    expect(result.errors[0].code).toBe('con.auth')

    expect(result.errors[1]).toBeInstanceOf(SimpleFinAccountError)
    expect(result.errors[1].code).toBe('act.unrecognized-subcode')

    expect(result.errors[2]).toBeInstanceOf(SimpleFinGeneralError)
    expect(result.errors[2].code).toBe('gen.rate_limited')

    expect(result.errors[3]).toBeInstanceOf(SimpleFinGeneralError)
    expect(result.errors[3].code).toBe('gen.unspecified')
  })

  it('error-legacy-errors-key.json: tolerates the legacy "errors" key when errlist is absent entirely', async () => {
    const body = loadFixture('error-legacy-errors-key.json')
    const { fetch } = makeFakeFetch([() => okResponse(body)])

    const result = await fetchAccounts(FAKE_ACCESS_URL, { fetch })

    expect(result.accounts).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toBeInstanceOf(SimpleFinConnectionError)
    expect(result.errors[0].code).toBe('con.auth')
  })

  it('merges errlist and errors if a response improbably has both', () => {
    const parsed = parseAccountSet({
      errlist: ['gen.one'],
      errors: ['gen.two'],
      accounts: [],
      connections: [],
    })
    expect(parsed.errors.map((e) => e.code)).toEqual(['gen.one', 'gen.two'])
  })
})

// ---------------------------------------------------------------------
// CRITICAL: the access URL and its userinfo must never appear in any
// thrown error message, across every failure mode this module has.
// ---------------------------------------------------------------------

describe('access URL redaction', () => {
  it('never sends the userinfo to fetch — only a stripped URL and an Authorization header', async () => {
    const body = loadFixture('accounts-v2-balances-only.json')
    const { fetch, calls } = makeFakeFetch([() => okResponse(body)])
    await fetchAccounts(FAKE_ACCESS_URL, { fetch })
    assertNoAccessUrl(calls[0].url)
  })

  it('never leaks the access URL when fetch itself throws with a message that embeds it', async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED ${FAKE_ACCESS_URL}`)
    }) as FetchLike
    const promise = fetchAccounts(FAKE_ACCESS_URL, { fetch: fetchImpl })
    await expect(promise).rejects.toBeInstanceOf(SimpleFinNetworkError)
    await promise.catch((error: Error) => assertNoAccessUrl(error.message))
  })

  it('never leaks the access URL when an HTTP error response body echoes it back', async () => {
    const scenarios: Array<() => Response> = [
      () => errorResponse(402, 'Payment Required', `renew at ${FAKE_ACCESS_URL}`),
      () => errorResponse(403, 'Forbidden', `already used by ${FAKE_ACCESS_URL}`),
      () => errorResponse(500, 'Internal Server Error', FAKE_ACCESS_URL),
    ]
    for (const scenario of scenarios) {
      const { fetch } = makeFakeFetch([scenario])
      await fetchAccounts(FAKE_ACCESS_URL, { fetch }).catch((error: Error) => assertNoAccessUrl(error.message))
    }
  })

  it('never leaks the access URL when a malformed 2xx body happens to contain it', async () => {
    const { fetch } = makeFakeFetch([() => okResponse(`not json but mentions ${FAKE_ACCESS_URL}`)])
    await fetchAccounts(FAKE_ACCESS_URL, { fetch }).catch((error: Error) => assertNoAccessUrl(error.message))
  })

  it('never leaks the access URL when a request-building failure occurs', () => {
    const scenarios = [
      () => buildAccountsRequest(`not a url but mentions ${FAKE_ACCESS_URL}`),
      () => buildAccountsRequest('ftp://bridge.example.org/simplefin'),
      () => buildAccountsRequest('https://bridge.example.org/simplefin'),
    ]
    for (const scenario of scenarios) {
      try {
        scenario()
        expect.unreachable('expected buildAccountsRequest to throw')
      } catch (error) {
        expect(error).toBeInstanceOf(SimpleFinRequestError)
        assertNoAccessUrl((error as Error).message)
      }
    }
  })

  it('never leaks the access URL when an errlist entry echoes it back (server-side reflection)', async () => {
    const malicious = {
      errlist: [`con.auth: reuse detected for ${FAKE_ACCESS_URL}`],
      accounts: [],
      connections: [],
    }
    const { fetch } = makeFakeFetch([() => okResponse(JSON.stringify(malicious))])
    const result = await fetchAccounts(FAKE_ACCESS_URL, { fetch })
    for (const error of result.errors) {
      assertNoAccessUrl(error.message)
    }
  })
})
