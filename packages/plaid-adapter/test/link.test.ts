import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AxiosResponse } from 'axios'
import type {
  ItemPublicTokenExchangeResponse,
  LinkTokenCreateResponse,
  SandboxPublicTokenCreateResponse,
} from 'plaid'
import {
  createLinkToken,
  runLinkFlow,
  runSandboxAutoFlow,
  type LinkFlowResult,
} from '../src/link.js'
import { LinkFlowError } from '../src/errors.js'
import { SqliteTokenStore } from '../src/token-store.js'
import type { PlaidClientLike } from '../src/plaid-client.types.js'
import { makeFakeTokenStore } from './fixtures/fakes.js'

// A representative (fake) access token. The whole point of the flow is that
// this string never appears in a return value, a thrown error, or on disk in
// plaintext — several tests assert exactly that.
const FAKE_ACCESS_TOKEN = 'access-sandbox-11112222-3333-4444-5555-666677778888'
const FAKE_ITEM_ID = 'item-sandbox-abc123'
const FAKE_PUBLIC_TOKEN = 'public-sandbox-99998888-7777-6666-5555-444433332222'

function toAxios<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  }
}

interface FakeLinkClientOptions {
  linkToken?: string
  exchange?: () => Promise<AxiosResponse<ItemPublicTokenExchangeResponse>>
  sandboxCreate?: () => Promise<AxiosResponse<SandboxPublicTokenCreateResponse>>
  onExchange?: (publicToken: string) => void
}

function makeLinkClient(options: FakeLinkClientOptions = {}): PlaidClientLike {
  const notImplemented = async (): Promise<never> => {
    throw new Error('fake client method not implemented in this test')
  }
  return {
    linkTokenCreate: async () =>
      toAxios<LinkTokenCreateResponse>({
        link_token: options.linkToken ?? 'link-sandbox-token-abc',
        expiration: '2026-01-01T00:00:00Z',
        request_id: 'req_link',
      }),
    itemPublicTokenExchange:
      options.exchange ??
      (async (request: { public_token: string }) => {
        options.onExchange?.(request.public_token)
        return toAxios<ItemPublicTokenExchangeResponse>({
          access_token: FAKE_ACCESS_TOKEN,
          item_id: FAKE_ITEM_ID,
          request_id: 'req_exchange',
        })
      }),
    sandboxPublicTokenCreate:
      options.sandboxCreate ??
      (async () =>
        toAxios<SandboxPublicTokenCreateResponse>({
          public_token: FAKE_PUBLIC_TOKEN,
          request_id: 'req_sandbox',
        })),
    accountsGet: notImplemented,
    accountsBalanceGet: notImplemented,
    transactionsSync: notImplemented,
    transactionsRecurringGet: notImplemented,
  } as unknown as PlaidClientLike
}

const SUCCESS_METADATA = {
  institution: { name: 'First Platypus Bank', institution_id: 'ins_109508' },
  accounts: [
    { id: 'acc_1', name: 'Plaid Checking', mask: '1111', type: 'depository', subtype: 'checking' },
  ],
}

async function postJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** True when a fresh server can bind `port` — i.e. the flow released it. */
async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true))
    })
  })
}

function assertNoAccessToken(value: unknown): void {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain('access-')
  expect(serialized).not.toContain(FAKE_ACCESS_TOKEN)
}

describe('createLinkToken', () => {
  it('requests the transactions product for the Clad client', async () => {
    let captured: unknown
    const client = {
      linkTokenCreate: async (request: unknown) => {
        captured = request
        return toAxios<LinkTokenCreateResponse>({
          link_token: 'link-sandbox-xyz',
          expiration: '2026-01-01T00:00:00Z',
          request_id: 'req_link',
        })
      },
    } as unknown as PlaidClientLike

    const token = await createLinkToken(client, { clientUserId: 'user-42' })
    expect(token).toBe('link-sandbox-xyz')
    expect(captured).toMatchObject({
      client_name: 'Clad',
      language: 'en',
      country_codes: ['US'],
      products: ['transactions'],
      user: { client_user_id: 'user-42' },
    })
  })
})

describe('runLinkFlow', () => {
  it('exchanges + stores the token (encrypted at rest) and resolves without the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clad-link-success-'))
    const dbPath = join(dir, 'plaid.sqlite')
    const store = new SqliteTokenStore({ dbPath, passphrase: 'unit-test-passphrase' })
    const client = makeLinkClient()

    try {
      const openBrowser = async (url: string): Promise<void> => {
        const res = await postJson(`${url}/callback`, {
          public_token: FAKE_PUBLIC_TOKEN,
          metadata: SUCCESS_METADATA,
        })
        expect(res.status).toBe(200)
      }

      const result: LinkFlowResult = await runLinkFlow({ client, tokenStore: store, openBrowser })

      expect(result.itemId).toBe(FAKE_ITEM_ID)
      expect(result.institutionName).toBe('First Platypus Bank')
      expect(result.accounts).toEqual([
        { id: 'acc_1', name: 'Plaid Checking', mask: '1111', type: 'depository', subtype: 'checking' },
      ])
      // No token anywhere in the resolved value.
      assertNoAccessToken(result)

      // Token really was persisted and is retrievable...
      expect(store.getAccessToken(FAKE_ITEM_ID)).toBe(FAKE_ACCESS_TOKEN)
      // ...but the on-disk bytes never contain it in plaintext.
      const raw = readFileSync(dbPath)
      expect(raw.includes(Buffer.from(FAKE_ACCESS_TOKEN))).toBe(false)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects with LinkFlowError (no token in message) when Link exits', async () => {
    const store = makeFakeTokenStore()
    const client = makeLinkClient()

    const openBrowser = async (url: string): Promise<void> => {
      await postJson(`${url}/exit`, {
        error: { error_code: 'INVALID_CREDENTIALS', display_message: 'bad creds' },
        metadata: {},
      })
    }

    const promise = runLinkFlow({ client, tokenStore: store, openBrowser })
    await expect(promise).rejects.toBeInstanceOf(LinkFlowError)
    await promise.catch((error: Error) => {
      expect(error.message).toContain('INVALID_CREDENTIALS')
      expect(error.message).not.toContain('access-')
    })
    expect(store.listItems()).toHaveLength(0)
  })

  it('rejects on timeout and frees the port', async () => {
    const store = makeFakeTokenStore()
    const client = makeLinkClient()

    let capturedPort = 0
    const openBrowser = (url: string): void => {
      capturedPort = Number(new URL(url).port)
      // Never drive the callback — force the timeout path.
    }

    await expect(
      runLinkFlow({ client, tokenStore: store, openBrowser, timeoutMs: 40 })
    ).rejects.toBeInstanceOf(LinkFlowError)

    expect(capturedPort).toBeGreaterThan(0)
    expect(await portIsFree(capturedPort)).toBe(true)
  })

  it('rejects a wrong random path segment and does not resolve from it', async () => {
    const store = makeFakeTokenStore()
    let exchanges = 0
    const client = makeLinkClient({ onExchange: () => { exchanges += 1 } })

    const openBrowser = async (url: string): Promise<void> => {
      const parsed = new URL(url)
      const base = `${parsed.protocol}//${parsed.host}`
      // A guessed/wrong path segment must be rejected outright...
      const wrong = await postJson(`${base}/deadbeefdeadbeef/callback`, {
        public_token: FAKE_PUBLIC_TOKEN,
        metadata: SUCCESS_METADATA,
      })
      expect(wrong.status).toBe(404)
      // ...and it must not have triggered an exchange or resolved the flow.
      expect(exchanges).toBe(0)
      // The correct path still completes the flow.
      const ok = await postJson(`${url}/callback`, {
        public_token: FAKE_PUBLIC_TOKEN,
        metadata: SUCCESS_METADATA,
      })
      expect(ok.status).toBe(200)
    }

    const result = await runLinkFlow({ client, tokenStore: store, openBrowser })
    expect(result.itemId).toBe(FAKE_ITEM_ID)
    expect(exchanges).toBe(1)
    assertNoAccessToken(result)
  })

  it('rejects with LinkFlowError when the token exchange fails', async () => {
    const store = makeFakeTokenStore()
    const client = makeLinkClient({
      exchange: async () => {
        const error = new Error('boom') as Error & { response: { data: unknown } }
        error.response = { data: { error_type: 'INVALID_INPUT', error_code: 'INVALID_PUBLIC_TOKEN' } }
        throw error
      },
    })

    const openBrowser = async (url: string): Promise<void> => {
      const res = await postJson(`${url}/callback`, {
        public_token: FAKE_PUBLIC_TOKEN,
        metadata: SUCCESS_METADATA,
      })
      expect(res.status).toBe(500)
    }

    const promise = runLinkFlow({ client, tokenStore: store, openBrowser })
    await expect(promise).rejects.toBeInstanceOf(LinkFlowError)
    await promise.catch((error: Error) => {
      expect(error.message).toContain('INVALID_PUBLIC_TOKEN')
      expect(error.message).not.toContain('access-')
    })
    expect(store.listItems()).toHaveLength(0)
  })

  it('serves the Link HTML on the single-use GET path', async () => {
    const store = makeFakeTokenStore()
    const client = makeLinkClient()

    const openBrowser = async (url: string): Promise<void> => {
      const page = await fetch(url)
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain('cdn.plaid.com/link/v2/stable/link-initialize.js')
      expect(html).toContain('Plaid.create')
      // Complete the flow so the promise settles.
      await postJson(`${url}/callback`, {
        public_token: FAKE_PUBLIC_TOKEN,
        metadata: SUCCESS_METADATA,
      })
    }

    const result = await runLinkFlow({ client, tokenStore: store, openBrowser })
    expect(result.itemId).toBe(FAKE_ITEM_ID)
  })
})

describe('runSandboxAutoFlow', () => {
  const originalEnv = process.env.PLAID_ENV

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLAID_ENV
    else process.env.PLAID_ENV = originalEnv
  })

  it('creates + exchanges + stores a sandbox item when PLAID_ENV=sandbox', async () => {
    process.env.PLAID_ENV = 'sandbox'
    const dir = mkdtempSync(join(tmpdir(), 'clad-link-sandbox-'))
    const dbPath = join(dir, 'plaid.sqlite')
    const store = new SqliteTokenStore({ dbPath, passphrase: 'unit-test-passphrase' })
    const client = makeLinkClient()

    try {
      const result = await runSandboxAutoFlow({ client, tokenStore: store })
      expect(result.itemId).toBe(FAKE_ITEM_ID)
      assertNoAccessToken(result)
      expect(store.getAccessToken(FAKE_ITEM_ID)).toBe(FAKE_ACCESS_TOKEN)
      const raw = readFileSync(dbPath)
      expect(raw.includes(Buffer.from(FAKE_ACCESS_TOKEN))).toBe(false)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to run when PLAID_ENV is not sandbox', async () => {
    process.env.PLAID_ENV = 'production'
    const store = makeFakeTokenStore()
    const client = makeLinkClient()

    await expect(runSandboxAutoFlow({ client, tokenStore: store })).rejects.toBeInstanceOf(
      LinkFlowError
    )
    expect(store.listItems()).toHaveLength(0)
  })
})
