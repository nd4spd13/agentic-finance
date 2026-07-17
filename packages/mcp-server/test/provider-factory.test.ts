import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DummyDataProvider, SqliteTokenStore, type PolicyConfig } from '@clad/core'
import { PlaidAdapter } from '@clad/plaid-adapter'
import { SimpleFinAdapter } from '@clad/simplefin-adapter'
import * as getBalances from '../src/tools/clad_get_balances.js'
import * as getTransactions from '../src/tools/clad_get_transactions.js'

// Covers env vars consumed by every provider branch createProvider() knows
// about (dummy needs none; plaid needs the first five; simplefin needs
// CLAD_TOKEN_PASSPHRASE + CLAD_SIMPLEFIN_DB) so one shared reset/restore
// loop can back every describe block below, regardless of which provider
// it's exercising.
const PROVIDER_ENV_KEYS = [
  'CLAD_PROVIDER',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'CLAD_TOKEN_PASSPHRASE',
  'CLAD_PLAID_DB',
  'CLAD_SIMPLEFIN_DB',
] as const

describe('createProvider', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
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

  it('rejects an unknown CLAD_PROVIDER value, naming every supported provider', async () => {
    process.env.CLAD_PROVIDER = 'bogus'
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(/dummy.*plaid.*simplefin/s)
  })

  it('throws naming all missing credentials when CLAD_PROVIDER=plaid and none are set', async () => {
    process.env.CLAD_PROVIDER = 'plaid'
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(
      /PLAID_CLIENT_ID.*PLAID_SECRET.*PLAID_ENV.*CLAD_TOKEN_PASSPHRASE/s
    )
  })

  it('throws naming only the specific missing credential(s)', async () => {
    process.env.CLAD_PROVIDER = 'plaid'
    process.env.PLAID_CLIENT_ID = 'test-client-id'
    process.env.PLAID_SECRET = 'test-secret'
    process.env.PLAID_ENV = 'sandbox'
    // CLAD_TOKEN_PASSPHRASE intentionally left unset
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(/CLAD_TOKEN_PASSPHRASE/)
    await expect(createProvider()).rejects.not.toThrow(/PLAID_CLIENT_ID/)
  })

  it('rejects an unsupported PLAID_ENV value', async () => {
    process.env.CLAD_PROVIDER = 'plaid'
    process.env.PLAID_CLIENT_ID = 'test-client-id'
    process.env.PLAID_SECRET = 'test-secret'
    process.env.PLAID_ENV = 'bogus-env'
    process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(/Unsupported PLAID_ENV "bogus-env"/)
  })

  describe('with full plaid credentials', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'clad-provider-factory-'))
      process.env.CLAD_PROVIDER = 'plaid'
      process.env.PLAID_CLIENT_ID = 'test-client-id'
      process.env.PLAID_SECRET = 'test-secret'
      process.env.PLAID_ENV = 'sandbox'
      process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
      process.env.CLAD_PLAID_DB = join(dir, 'nested', 'plaid.sqlite')
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('constructs a PlaidAdapter at the CLAD_PLAID_DB path (no network access)', async () => {
      const { createProvider } = await import('../src/provider-factory.js')
      const provider = await createProvider()
      expect(provider).toBeInstanceOf(PlaidAdapter)
    })

    it('fails fast with a redacted error on a wrong passphrase', async () => {
      const { createProvider } = await import('../src/provider-factory.js')
      await createProvider() // first open writes the key-check
      process.env.CLAD_TOKEN_PASSPHRASE = 'a-different-passphrase'
      const error = await createProvider().then(
        () => {
          throw new Error('expected createProvider to reject')
        },
        (e: unknown) => e as Error
      )
      expect(error.message).not.toContain('test-passphrase')
      expect(error.message).not.toContain('a-different-passphrase')
    })
  })

  it('throws naming the missing credential when CLAD_PROVIDER=simplefin and CLAD_TOKEN_PASSPHRASE is unset', async () => {
    process.env.CLAD_PROVIDER = 'simplefin'
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider()).rejects.toThrow(/CLAD_TOKEN_PASSPHRASE/)
  })

  describe('with a simplefin passphrase configured', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'clad-provider-factory-simplefin-'))
      process.env.CLAD_PROVIDER = 'simplefin'
      process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
      process.env.CLAD_SIMPLEFIN_DB = join(dir, 'nested', 'simplefin.sqlite')
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('constructs a SimpleFinAdapter at the CLAD_SIMPLEFIN_DB path (no network access)', async () => {
      const { createProvider } = await import('../src/provider-factory.js')
      const provider = await createProvider()
      expect(provider).toBeInstanceOf(SimpleFinAdapter)
    })

    it('fails fast with a redacted error on a wrong passphrase', async () => {
      const { createProvider } = await import('../src/provider-factory.js')
      await createProvider() // first open writes the key-check
      process.env.CLAD_TOKEN_PASSPHRASE = 'a-different-passphrase'
      const error = await createProvider().then(
        () => {
          throw new Error('expected createProvider to reject')
        },
        (e: unknown) => e as Error
      )
      expect(error.message).not.toContain('test-passphrase')
      expect(error.message).not.toContain('a-different-passphrase')
    })
  })
})

/**
 * SF5 acceptance proof: "the MCP server can be constructed with the
 * simplefin provider configured and serves balances/transactions tools."
 *
 * `createProvider()` itself has no fake-network seam by design — like
 * `createPlaidProvider()`, it only ever wires up a real adapter against a
 * real network, so `createProvider`'s own tests above stop at "constructs
 * the right class." This suite drives the actual data path: a
 * `SimpleFinAdapter` built the exact same way `createSimpleFinProvider`
 * builds one (same `SqliteTokenStore` class, same constructor shape),
 * fed a fake `fetch` serving a real captured SF1 response, run through the
 * same `clad_get_balances`/`clad_get_transactions` tool handlers the MCP
 * server dispatches to at runtime.
 */
describe('SimpleFinAdapter end to end through the MCP tool handlers (SF1 fixture data)', () => {
  let dir: string
  let dbPath: string
  let tokenStore: SqliteTokenStore

  const policy: PolicyConfig = {
    agents: {
      'test-agent': {
        description: 'Test agent',
        permissions: {
          accounts: { visible: ['checking', 'savings'], balance: true },
          transactions: { read: true },
        },
      },
    },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clad-provider-factory-simplefin-data-'))
    dbPath = join(dir, 'simplefin.sqlite')
    tokenStore = new SqliteTokenStore({ dbPath, passphrase: 'test-passphrase' })
    tokenStore.saveItem({
      itemId: 'item_1',
      institutionName: 'SimpleFIN',
      accessToken: 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/item1',
    })
  })

  afterEach(() => {
    tokenStore.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves clad_get_balances and clad_get_transactions from real SF1 fixture data (no network access)', async () => {
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'simplefin-adapter',
      'test',
      'fixtures',
      'accounts-v2-plain.json'
    )
    const fixtureBody = readFileSync(fixturePath, 'utf-8')
    const fetchImpl = (async () => new Response(fixtureBody, { status: 200 })) as unknown as typeof fetch

    const provider = new SimpleFinAdapter({ tokenStore, dbPath, passphrase: 'test-passphrase', fetch: fetchImpl })
    const context = { agentId: 'test-agent', policy, provider }

    const balancesResult = await getBalances.handler({}, context)
    const balances = JSON.parse(balancesResult.content[0].text) as Array<{
      account_id: string
      current: number
    }>
    expect(balances).toHaveLength(3)
    expect(balances.find((b) => b.account_id === 'simplefin:fixture-acct-checking')?.current).toBe(
      24668.87
    )

    const transactionsResult = await getTransactions.handler(
      { account_id: 'simplefin:fixture-acct-savings' },
      context
    )
    const transactions = JSON.parse(transactionsResult.content[0].text) as Array<{ id: string }>
    expect(transactions).toHaveLength(4)
  })
})
