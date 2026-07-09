/**
 * `clad connect` tests (SF6).
 *
 * Covers:
 *  - provider dispatch (default/explicit 'plaid', 'simplefin', unsupported)
 *  - SimpleFIN claim-failure UX paths (malformed token, reused/rejected
 *    token, claim network error) — no item is ever stored for these
 *  - SimpleFIN storage call shape (item persisted before the initial
 *    account-summary fetch is attempted, so a one-time setup token is never
 *    lost just because that follow-up fetch failed)
 *  - masked-summary formatting, plus the standing security invariant: the
 *    access URL (and its embedded basic-auth userinfo) must never appear in
 *    anything written to stdout/stderr or to the prompt output stream.
 *
 * No test in this file touches the network: every SimpleFIN call goes
 * through an injected fake `fetch` (via `ConnectOptions.fetch`), matching the
 * convention `@clad/simplefin-adapter`'s own test suite uses. Readline
 * prompts are driven by an injected stdin (`ConnectOptions.input`) rather
 * than the real `process.stdin`.
 */

import { Readable, Writable } from 'node:stream'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FetchLike } from '@clad/simplefin-adapter'

const TEST_DIR = join(tmpdir(), `clad-connect-test-${process.pid}`)

const FAKE_ACCESS_URL = 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/abc123'
const FAKE_USERINFO = 'sfin-user:sfin-p4ss'
const FAKE_CLAIM_URL = 'https://bridge.example.org/simplefin/claim/one-time-token-xyz'

function encodeSetupToken(url: string): string {
  return Buffer.from(url, 'utf-8').toString('base64')
}

/** Readable stdin that yields each line (with a trailing newline) in order. */
function stdinFromLines(...lines: string[]): NodeJS.ReadableStream {
  return Readable.from([lines.map((l) => `${l}\n`).join('')])
}

/** Writable that records every chunk written to it as a string. */
function capturingOutput(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, callback) {
      lines.push(chunk.toString())
      callback()
    },
  })
  return { stream, lines }
}

/**
 * Fake `fetch` that returns each provided response factory in order (the
 * last one repeats if called more times than there are factories). Exposes
 * a live call counter via a getter so callers can assert on it after the
 * fact without needing to read a captured closure variable directly.
 */
function makeFakeFetch(factories: Array<() => Response | Promise<Response>>): {
  fetch: FetchLike
  readonly callCount: number
} {
  let count = 0
  const fetchImpl = (async () => {
    const factory = factories[Math.min(count, factories.length - 1)]
    count += 1
    return factory()
  }) as FetchLike
  return {
    fetch: fetchImpl,
    get callCount(): number {
      return count
    },
  }
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200, statusText: 'OK' })
}

function errorResponse(status: number, statusText: string, body = ''): Response {
  return new Response(body, { status, statusText })
}

/** A minimal, valid SimpleFIN v2 AccountSet body with one account/connection. */
function fakeAccountSetBody(): string {
  return JSON.stringify({
    errlist: [],
    accounts: [
      {
        id: 'acct-0001-abcdefg1234',
        name: 'Everyday Checking',
        currency: 'USD',
        balance: '532.10',
        'available-balance': '500.00',
        'balance-date': 1783555200,
        transactions: [],
        holdings: [],
        conn_id: 'conn-1',
      },
    ],
    connections: [
      {
        conn_id: 'conn-1',
        name: 'Test Bank',
        org_id: 'org-1',
        org_name: 'Test Bank Financial',
        org_url: 'https://testbank.example',
        sfin_url: 'https://bridge.example.org/simplefin',
      },
    ],
  })
}

function assertNoAccessUrl(haystack: string): void {
  expect(haystack).not.toContain(FAKE_ACCESS_URL)
  expect(haystack).not.toContain(FAKE_USERINFO)
}

let logs: string[]
let errs: string[]
let origLog: typeof console.log
let origErr: typeof console.error
let origExitCode: string | number | undefined

beforeEach(() => {
  process.env.CLAD_CONFIG_DIR = TEST_DIR
  mkdirSync(TEST_DIR, { recursive: true })

  logs = []
  errs = []
  origLog = console.log
  origErr = console.error
  console.log = (...args: unknown[]) => {
    logs.push(args.join(' '))
  }
  console.error = (...args: unknown[]) => {
    errs.push(args.join(' '))
  }
  origExitCode = process.exitCode
  process.exitCode = undefined
})

afterEach(() => {
  console.log = origLog
  console.error = origErr
  process.exitCode = origExitCode
  delete process.env.CLAD_CONFIG_DIR
  delete process.env.CLAD_TOKEN_PASSPHRASE
  delete process.env.PLAID_CLIENT_ID
  delete process.env.PLAID_SECRET
  delete process.env.PLAID_ENV
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
})

// ── Provider dispatch ────────────────────────────────────────────────────

describe('connectCommand provider dispatch', () => {
  it('rejects an unsupported --provider value, naming every supported provider', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    await connectCommand({ provider: 'bogus' })
    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toMatch(/unsupported --provider "bogus"/)
    expect(errs.join('\n')).toMatch(/plaid.*simplefin/)
  })

  it('defaults to the plaid flow when no provider is given (unchanged CLI behavior)', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    await connectCommand({})
    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toContain('PLAID_CLIENT_ID')
  })

  it('routes explicit --provider plaid the same as the default', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    await connectCommand({ provider: 'plaid' })
    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toContain('PLAID_CLIENT_ID')
  })
})

// ── SimpleFIN: claim-failure UX paths ────────────────────────────────────

describe('connectCommand --provider simplefin: claim failures', () => {
  beforeEach(() => {
    process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
  })

  it('reports a malformed (non-base64) setup token and stores nothing', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    const { fetch, callCount } = makeFakeFetch([() => okResponse(FAKE_ACCESS_URL)])
    const output = capturingOutput()

    await connectCommand({
      provider: 'simplefin',
      fetch,
      input: stdinFromLines('not-valid-base64!!! not a token'),
      output: output.stream,
    })

    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toMatch(/not valid base64/i)
    expect(callCount).toBe(0) // decode fails before any network call

    const { SqliteTokenStore } = await import('@clad/core')
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'test-passphrase' })
    try {
      expect(store.listItems()).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('reports an empty setup token and stores nothing, without touching the network', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    const { fetch, callCount } = makeFakeFetch([() => okResponse(FAKE_ACCESS_URL)])

    await connectCommand({
      provider: 'simplefin',
      fetch,
      input: stdinFromLines(''),
      output: capturingOutput().stream,
    })

    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toMatch(/setup token is required/i)
    expect(callCount).toBe(0)
  })

  it('reports a reused/rejected setup token (non-2xx claim response) and stores nothing', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([() => errorResponse(403, 'Forbidden')])

    await connectCommand({
      provider: 'simplefin',
      fetch,
      input: stdinFromLines(token),
      output: capturingOutput().stream,
    })

    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toMatch(/one-time use/i)

    const { SqliteTokenStore } = await import('@clad/core')
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'test-passphrase' })
    try {
      expect(store.listItems()).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('reports a claim network failure and stores nothing', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as FetchLike

    await connectCommand({
      provider: 'simplefin',
      fetch: fetchImpl,
      input: stdinFromLines(token),
      output: capturingOutput().stream,
    })

    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toMatch(/failed to reach the simplefin claim url/i)

    const { SqliteTokenStore } = await import('@clad/core')
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'test-passphrase' })
    try {
      expect(store.listItems()).toHaveLength(0)
    } finally {
      store.close()
    }
  })
})

// ── SimpleFIN: storage call shape ────────────────────────────────────────

describe('connectCommand --provider simplefin: storage call shape', () => {
  beforeEach(() => {
    process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
  })

  it('persists the item (with a simplefin-prefixed itemId) even when the follow-up account fetch fails', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([
      () => okResponse(FAKE_ACCESS_URL),
      () => errorResponse(500, 'Internal Server Error'),
    ])
    const output = capturingOutput()

    await connectCommand({
      provider: 'simplefin',
      fetch,
      input: stdinFromLines(token),
      output: output.stream,
    })

    // Not a hard failure: the credential was saved even though the summary
    // fetch failed, so exitCode should remain unset (success).
    expect(process.exitCode).toBeUndefined()
    expect(logs.join('\n')).toMatch(/Could not fetch an initial account summary yet/)
    expect(logs.join('\n')).toMatch(/credentials were saved/)

    const { SqliteTokenStore } = await import('@clad/core')
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'test-passphrase' })
    try {
      const items = store.listItems()
      expect(items).toHaveLength(1)
      expect(items[0].itemId).toMatch(/^simplefin-/)
      expect(items[0].institutionName).toBe('SimpleFIN Bridge')
      expect(store.getAccessToken(items[0].itemId)).toBe(FAKE_ACCESS_URL)
    } finally {
      store.close()
    }

    const allOutput = [...logs, ...errs, ...output.lines].join('\n')
    assertNoAccessUrl(allOutput)
  })
})

// ── SimpleFIN: masked-summary formatting ─────────────────────────────────

describe('connectCommand --provider simplefin: masked summary', () => {
  beforeEach(() => {
    process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
  })

  it('prints institution + account name with a masked identifier, never the raw access URL', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([
      () => okResponse(FAKE_ACCESS_URL),
      () => okResponse(fakeAccountSetBody()),
    ])
    const output = capturingOutput()

    await connectCommand({
      provider: 'simplefin',
      fetch,
      input: stdinFromLines(token),
      output: output.stream,
    })

    expect(process.exitCode).toBeUndefined()
    const printed = logs.join('\n')
    expect(printed).toContain('Test Bank Financial')
    expect(printed).toContain('Everyday Checking')
    expect(printed).toContain('••••1234') // last 4 of the raw account id
    expect(printed).not.toContain('acct-0001-abcdefg1234') // full raw id never shown

    const allOutput = [...logs, ...errs, ...output.lines].join('\n')
    assertNoAccessUrl(allOutput)
  })

  it('supports --use, setting the provider to simplefin in config.json', async () => {
    const { connectCommand } = await import('../src/commands/connect.js')
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([
      () => okResponse(FAKE_ACCESS_URL),
      () => okResponse(fakeAccountSetBody()),
    ])

    await connectCommand({
      provider: 'simplefin',
      use: true,
      fetch,
      input: stdinFromLines(token),
      output: capturingOutput().stream,
    })

    expect(process.exitCode).toBeUndefined()
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().provider).toBe('simplefin')
  })

  it('drives the setup-token prompt from injected/piped stdin (CLAD_TOKEN_PASSPHRASE set via env, matching the real connect flow)', async () => {
    // Mirrors the actual `clad connect --provider simplefin` usage pattern
    // (and this task's e2e acceptance flow): the passphrase comes from
    // CLAD_TOKEN_PASSPHRASE so only the one-line setup token prompt reads
    // from stdin. (Piping two sequential answers into one already-buffered,
    // non-tty stream across two separately-constructed `readline.Interface`
    // instances is not reliable — the first interface consumes all
    // available buffered data, leaving nothing for the second — a Node
    // readline limitation, not a `connect.ts` bug; it only works against a
    // real TTY, where input arrives incrementally as the user types.)
    const { connectCommand } = await import('../src/commands/connect.js')
    const token = encodeSetupToken(FAKE_CLAIM_URL)
    const { fetch } = makeFakeFetch([
      () => okResponse(FAKE_ACCESS_URL),
      () => okResponse(fakeAccountSetBody()),
    ])
    const output = capturingOutput()

    await connectCommand({
      provider: 'simplefin',
      fetch,
      input: stdinFromLines(token),
      output: output.stream,
    })

    expect(process.exitCode).toBeUndefined()
    expect(logs.join('\n')).toContain('Everyday Checking')

    const { SqliteTokenStore } = await import('@clad/core')
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'test-passphrase' })
    try {
      expect(store.listItems()).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})
