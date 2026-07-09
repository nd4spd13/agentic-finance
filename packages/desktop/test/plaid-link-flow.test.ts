/**
 * D3.1 Plaid Link in-app flow tests.
 *
 * `PlaidLinkFlowManager` reuses `@clad/plaid-adapter`'s real `runLinkFlow`/
 * `runSandboxAutoFlow` under the hood, so these tests exercise the real
 * loopback HTTP server those functions stand up — but never the real Plaid
 * network: the `client` passed to them is always a local fake (via the
 * `createClient` test seam), and the `openExternal`/`openBrowser` hook talks
 * only to `127.0.0.1` (the flow's own loopback server), exactly like
 * `@clad/plaid-adapter`'s own `link.test.ts`. No test here spawns a real
 * browser or touches a remote host.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PlaidLinkFlowManager,
  isExpectedPlaidLinkUrl,
  getPlaidConnectionState,
  type PlaidLinkFlowStatus,
} from '../src/main/lib/plaid-link-flow.js'
import type { CladConfig } from '../src/main/lib/config.js'

const FAKE_ACCESS_TOKEN = 'access-sandbox-11112222-3333-4444-5555-666677778888'
const FAKE_ITEM_ID = 'item-sandbox-abc123'
const FAKE_PUBLIC_TOKEN = 'public-sandbox-99998888-7777-6666-5555-444433332222'

const SUCCESS_METADATA = {
  institution: { name: 'First Platypus Bank', institution_id: 'ins_109508' },
  accounts: [{ id: 'acc_1', name: 'Plaid Checking', mask: '1111', type: 'depository', subtype: 'checking' }],
}

interface FakeClientOptions {
  exchangeDelayMs?: number
  onExchange?: () => void
}

/** A minimal fake `PlaidClientLike` — never touches the real Plaid network. */
function makeFakeClient(options: FakeClientOptions = {}) {
  return {
    linkTokenCreate: async () => ({
      data: { link_token: 'link-sandbox-token-abc', expiration: '2026-01-01T00:00:00Z', request_id: 'req_link' },
    }),
    itemPublicTokenExchange: async (_request: { public_token: string }) => {
      options.onExchange?.()
      if (options.exchangeDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.exchangeDelayMs))
      }
      return {
        data: { access_token: FAKE_ACCESS_TOKEN, item_id: FAKE_ITEM_ID, request_id: 'req_exchange' },
      }
    },
    sandboxPublicTokenCreate: async () => ({
      data: { public_token: FAKE_PUBLIC_TOKEN, request_id: 'req_sandbox' },
    }),
    accountsGet: async () => {
      throw new Error('not implemented in this fake')
    },
    accountsBalanceGet: async () => {
      throw new Error('not implemented in this fake')
    },
    transactionsSync: async () => {
      throw new Error('not implemented in this fake')
    },
    transactionsRecurringGet: async () => {
      throw new Error('not implemented in this fake')
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

async function postJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function makeConfig(overrides: Partial<CladConfig> = {}): CladConfig {
  const base = dir ?? (dir = mkdtempSync(join(tmpdir(), 'clad-desktop-plaid-link-flow-test-')))
  return {
    policy_path: join(base, 'policy.yaml'),
    audit_db: join(base, 'audit.sqlite'),
    approval_db: join(base, 'approvals.sqlite'),
    server_pid_file: join(base, 'server.pid'),
    provider: 'dummy',
    plaid_db: join(base, 'plaid.sqlite'),
    plaid_env: 'sandbox',
    close_to_tray: true,
    ...overrides,
  }
}

describe('isExpectedPlaidLinkUrl', () => {
  it('accepts an http loopback URL', () => {
    expect(isExpectedPlaidLinkUrl('http://127.0.0.1:54321/abc123')).toBe(true)
    expect(isExpectedPlaidLinkUrl('http://localhost:54321/abc123')).toBe(true)
  })

  it('rejects https, non-loopback hosts, and malformed URLs', () => {
    expect(isExpectedPlaidLinkUrl('https://127.0.0.1:54321/abc')).toBe(false)
    expect(isExpectedPlaidLinkUrl('http://evil.example.com/abc')).toBe(false)
    expect(isExpectedPlaidLinkUrl('not a url')).toBe(false)
  })
})

describe('PlaidLinkFlowManager', () => {
  it('starts idle', () => {
    const manager = new PlaidLinkFlowManager({
      loadConfig: () => makeConfig(),
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      openExternal: () => undefined,
      isDevBuild: () => true,
      onStatusChange: () => undefined,
    })
    expect(manager.getStatus()).toEqual({ state: 'idle' })
  })

  it('reports an error status (and pushes it) when Plaid credentials are missing', async () => {
    const pushed: PlaidLinkFlowStatus[] = []
    const manager = new PlaidLinkFlowManager({
      loadConfig: () => makeConfig(),
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => 'pass',
      openExternal: () => undefined,
      isDevBuild: () => true,
      onStatusChange: (status) => pushed.push(status),
    })

    const status = await manager.start()

    expect(status.state).toBe('error')
    expect(status.error).toMatch(/credentials/i)
    expect(pushed.at(-1)).toEqual(status)
  })

  it('reports an error status when the token-store passphrase is not resolved', async () => {
    const manager = new PlaidLinkFlowManager({
      loadConfig: () => makeConfig(),
      loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
      getActivePassphrase: () => null,
      openExternal: () => undefined,
      isDevBuild: () => true,
      onStatusChange: () => undefined,
    })

    const status = await manager.start()
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/passphrase/i)
  })

  describe('sandbox-auto dev flag', () => {
    it('rejects sandbox-auto outside a dev build', async () => {
      const manager = new PlaidLinkFlowManager({
        loadConfig: () => makeConfig({ plaid_env: 'sandbox' }),
        loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
        getActivePassphrase: () => 'pass',
        openExternal: () => undefined,
        isDevBuild: () => false,
        onStatusChange: () => undefined,
      })

      const status = await manager.start({ sandboxAuto: true })
      expect(status.state).toBe('error')
      expect(status.error).toMatch(/development build/i)
    })

    it('rejects sandbox-auto outside PLAID_ENV=sandbox even in a dev build', async () => {
      const manager = new PlaidLinkFlowManager({
        loadConfig: () => makeConfig({ plaid_env: 'production' }),
        loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
        getActivePassphrase: () => 'pass',
        openExternal: () => undefined,
        isDevBuild: () => true,
        onStatusChange: () => undefined,
      })

      const status = await manager.start({ sandboxAuto: true })
      expect(status.state).toBe('error')
      expect(status.error).toMatch(/sandbox/i)
    })

    it('runs sandbox-auto (no browser) in a dev build with PLAID_ENV=sandbox', async () => {
      const config = makeConfig({ plaid_env: 'sandbox' })
      let openExternalCalled = false
      const manager = new PlaidLinkFlowManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
        getActivePassphrase: () => 'pass',
        openExternal: () => {
          openExternalCalled = true
        },
        isDevBuild: () => true,
        createClient: () => makeFakeClient(),
        onStatusChange: () => undefined,
      })

      const status = await manager.start({ sandboxAuto: true })

      expect(status.state).toBe('success')
      expect(openExternalCalled).toBe(false) // no browser involved
    })
  })

  describe('the interactive (browser) flow', () => {
    it('opens an expected loopback URL, exchanges + stores the token, and resolves without it', async () => {
      const config = makeConfig()
      const pushed: PlaidLinkFlowStatus[] = []
      let capturedUrl: string | undefined

      const manager = new PlaidLinkFlowManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
        getActivePassphrase: () => 'unit-test-passphrase',
        createClient: () => makeFakeClient(),
        isDevBuild: () => true,
        openExternal: async (url) => {
          capturedUrl = url
          const res = await postJson(`${url}/callback`, {
            public_token: FAKE_PUBLIC_TOKEN,
            metadata: SUCCESS_METADATA,
          })
          expect(res.status).toBe(200)
        },
        onStatusChange: (status) => pushed.push(status),
      })

      const status = await manager.start()

      expect(capturedUrl && isExpectedPlaidLinkUrl(capturedUrl)).toBe(true)
      expect(status.state).toBe('success')
      expect(status.itemId).toBe(FAKE_ITEM_ID)
      expect(status.institutionName).toBe('First Platypus Bank')
      expect(status.accounts).toEqual([{ id: 'acc_1', name: 'Plaid Checking', mask: '1111' }])
      // Never a token anywhere in the pushed statuses.
      expect(JSON.stringify(pushed)).not.toContain(FAKE_ACCESS_TOKEN)
      // Pushed 'pending' then 'success'.
      expect(pushed.map((s) => s.state)).toEqual(['pending', 'success'])

      // Really persisted: connection state now reports 'connected'.
      const state = await getPlaidConnectionState({
        loadConfig: () => config,
        getActivePassphrase: () => 'unit-test-passphrase',
      })
      expect(state).toBe('connected')
    })

    it('reports an error status (no token) when Link exits', async () => {
      const manager = new PlaidLinkFlowManager({
        loadConfig: () => makeConfig(),
        loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
        getActivePassphrase: () => 'unit-test-passphrase',
        createClient: () => makeFakeClient(),
        isDevBuild: () => true,
        openExternal: async (url) => {
          await postJson(`${url}/exit`, {
            error: { error_code: 'INVALID_CREDENTIALS' },
            metadata: {},
          })
        },
        onStatusChange: () => undefined,
      })

      const status = await manager.start()
      expect(status.state).toBe('error')
      expect(status.error).toContain('INVALID_CREDENTIALS')
      expect(status.error).not.toContain(FAKE_ACCESS_TOKEN)
    })

    it('a second start() while pending is a no-op that returns the pending status', async () => {
      let exchanges = 0
      const manager = new PlaidLinkFlowManager({
        loadConfig: () => makeConfig(),
        loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
        getActivePassphrase: () => 'unit-test-passphrase',
        createClient: () => makeFakeClient({ onExchange: () => (exchanges += 1) }),
        isDevBuild: () => true,
        // Short timeout so the abandoned first flow's own internal server
        // closes quickly instead of waiting out `runLinkFlow`'s real 5-minute
        // default — this test never drives the callback on purpose.
        timeoutMs: 50,
        openExternal: () => {
          // Never drive the callback — flow stays pending.
        },
        onStatusChange: () => undefined,
      })

      const first = manager.start() // don't await yet — it's now 'pending'
      await Promise.resolve()
      expect(manager.getStatus().state).toBe('pending')

      const second = await manager.start()
      expect(second.state).toBe('pending')
      expect(exchanges).toBe(0)

      manager.cancel()
      // Let the abandoned flow's own timeout settle so its loopback server
      // is closed before the test ends (see plaid-link-flow.ts's "CANCEL /
      // TEARDOWN" doc comment: cancel() itself doesn't reach into it).
      await first.catch(() => undefined)
    })

    it('cancel() flips status to idle immediately and discards a late successful resolution', async () => {
      const config = makeConfig()
      const pushed: PlaidLinkFlowStatus[] = []
      let releaseExchange: (() => void) | undefined
      const manager = new PlaidLinkFlowManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => ({ clientId: 'id', secret: 'sec' }),
        getActivePassphrase: () => 'unit-test-passphrase',
        createClient: () =>
          makeFakeClient({
            exchangeDelayMs: 0,
          }),
        isDevBuild: () => true,
        openExternal: async (url) => {
          // Fire the callback but don't await its completion — we want start()
          // to still be in-flight when cancel() is called below.
          void postJson(`${url}/callback`, { public_token: FAKE_PUBLIC_TOKEN, metadata: SUCCESS_METADATA })
          await new Promise<void>((resolve) => {
            releaseExchange = resolve
          })
        },
        onStatusChange: (status) => pushed.push(status),
      })

      const startPromise = manager.start()
      await Promise.resolve()
      expect(manager.getStatus().state).toBe('pending')

      const cancelled = manager.cancel()
      expect(cancelled.state).toBe('idle')
      expect(manager.getStatus().state).toBe('idle')

      releaseExchange?.()
      await startPromise

      // The late success must not clobber the cancelled/idle state.
      expect(manager.getStatus().state).toBe('idle')
      expect(pushed.map((s) => s.state)).toEqual(['pending', 'idle'])
    })
  })
})

describe('getPlaidConnectionState', () => {
  it('is "unavailable" when the passphrase is not resolved', async () => {
    const state = await getPlaidConnectionState({
      loadConfig: () => makeConfig(),
      getActivePassphrase: () => null,
    })
    expect(state).toBe('unavailable')
  })

  it('is "not-connected" when the passphrase resolves but no item has been saved', async () => {
    const state = await getPlaidConnectionState({
      loadConfig: () => makeConfig(),
      getActivePassphrase: () => 'unit-test-passphrase',
    })
    expect(state).toBe('not-connected')
  })
})
