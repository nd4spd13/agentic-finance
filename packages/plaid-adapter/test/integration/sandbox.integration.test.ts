/**
 * Plaid Sandbox integration test (CRS-25 WP7).
 *
 * Exercises `PlaidAdapter` end to end against the REAL Plaid sandbox API —
 * no fakes, no mocks. This is the one test file in the repo that makes
 * outbound network calls.
 *
 * Gated behind `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV=sandbox` so
 * `pnpm test` stays green (and this file reports as *skipped*, not failed)
 * on any machine without sandbox credentials — including CI. To actually
 * run it locally:
 *
 *   PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox \
 *     pnpm --filter @clad/plaid-adapter test:integration
 *
 * All state (encrypted token store DB + Plaid cache DB) lives in a temp
 * directory created for this run — nothing under `~/.clad` is touched.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'
import { ProviderUnavailableError, SqliteTokenStore, type Transaction } from '@clad/core'
import { PlaidAdapter } from '../../src/adapter.js'
import { runSandboxAutoFlow } from '../../src/link.js'
import type { PlaidClientLike } from '../../src/plaid-client.types.js'

const hasSandboxCredentials =
  Boolean(process.env.PLAID_CLIENT_ID) &&
  Boolean(process.env.PLAID_SECRET) &&
  process.env.PLAID_ENV === 'sandbox'

// Sandbox transactions are seeded asynchronously; `/transactions/sync` can
// return PRODUCT_NOT_READY for a little while after the item is created.
// Poll generously rather than failing fast.
const SYNC_POLL_ATTEMPTS = 20
const SYNC_POLL_INTERVAL_MS = 3_000
const TEST_TIMEOUT_MS = 120_000

const TEST_PASSPHRASE = 'crs-25-wp7-sandbox-integration-test-passphrase'

describe.runIf(hasSandboxCredentials)('PlaidAdapter (Plaid sandbox integration)', () => {
  let tmpDir: string
  let tokenDbPath: string
  let cacheDbPath: string
  let client: PlaidClientLike
  let tokenStore: SqliteTokenStore
  let adapter: PlaidAdapter
  let userId: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clad-plaid-sandbox-it-'))
    tokenDbPath = join(tmpDir, 'plaid-tokens.sqlite')
    cacheDbPath = join(tmpDir, 'plaid-cache.sqlite')
    userId = 'sandbox-integration-user'

    const basePath = PlaidEnvironments[process.env.PLAID_ENV as string]
    client = new PlaidApi(
      new Configuration({
        basePath,
        baseOptions: {
          headers: {
            'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
            'PLAID-SECRET': process.env.PLAID_SECRET,
          },
        },
      })
    ) as unknown as PlaidClientLike

    tokenStore = new SqliteTokenStore({ dbPath: tokenDbPath, passphrase: TEST_PASSPHRASE })
  })

  afterAll(() => {
    tokenStore?.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it(
    'runs the full connect -> read data flow against Plaid sandbox',
    async () => {
      // --- Connect: runSandboxAutoFlow stores an encrypted item ----------
      const linkResult = await runSandboxAutoFlow({ client, tokenStore })
      expect(linkResult.itemId).toBeTruthy()
      expect(tokenStore.listItems()).toHaveLength(1)
      expect(tokenStore.listItems()[0].itemId).toBe(linkResult.itemId)

      adapter = new PlaidAdapter({ client, tokenStore, dbPath: cacheDbPath, passphrase: TEST_PASSPHRASE })

      // --- Accounts --------------------------------------------------------
      const accounts = await adapter.getAccounts(userId)
      expect(Array.isArray(accounts)).toBe(true)
      expect(accounts.length).toBeGreaterThan(0)
      for (const account of accounts) {
        expect(typeof account.id).toBe('string')
        expect(typeof account.name).toBe('string')
        expect(['checking', 'savings', 'credit', 'loan', 'investment']).toContain(account.type)
        expect(typeof account.balance_current).toBe('number')
        expect(typeof account.currency).toBe('string')
      }

      const accountId = accounts[0].id

      // --- Balance -----------------------------------------------------
      const balance = await adapter.getBalance(userId, accountId)
      expect(balance.account_id).toBe(accountId)
      expect(typeof balance.current).toBe('number')
      expect(typeof balance.currency).toBe('string')
      expect(typeof balance.last_updated).toBe('string')

      // --- Transactions (sync pagination, with PRODUCT_NOT_READY retry) ---
      const transactions = await waitForTransactions(adapter, userId, accountId)
      expect(Array.isArray(transactions)).toBe(true)
      for (const txn of transactions) {
        expect(typeof txn.id).toBe('string')
        expect(txn.account_id).toBe(accountId)
        expect(typeof txn.amount).toBe('number')
        expect(typeof txn.date).toBe('string')
        expect(typeof txn.description).toBe('string')
        expect(typeof txn.pending).toBe('boolean')
      }
      // Core sign convention: money leaving the account is negative. Plaid's
      // sandbox seed data always includes at least one outflow (e.g. a debit
      // card purchase) alongside inflows (e.g. payroll deposits).
      const outflows = transactions.filter(t => t.amount < 0)
      expect(outflows.length).toBeGreaterThan(0)

      // --- Recurring charges (shape only; sandbox may not have detected any) ---
      const recurring = await adapter.getRecurringCharges(userId, accountId)
      expect(Array.isArray(recurring)).toBe(true)
      for (const charge of recurring) {
        expect(typeof charge.description).toBe('string')
        expect(typeof charge.amount).toBe('number')
        expect(['weekly', 'biweekly', 'monthly', 'annually']).toContain(charge.frequency)
        expect(typeof charge.next_date).toBe('string')
        expect(['high', 'medium', 'low']).toContain(charge.confidence)
        expect(charge.source).toBe('provider')
      }

      // --- Tokens encrypted at rest: no `access-` token substring on disk ---
      const raw = readFileSync(tokenDbPath)
      expect(raw.toString('utf8')).not.toContain('access-')
      expect(raw.toString('latin1')).not.toContain('access-')
    },
    TEST_TIMEOUT_MS
  )
})

/**
 * Calls `adapter.getTransactions`, retrying while Plaid reports
 * `PRODUCT_NOT_READY` (sandbox transaction data is seeded asynchronously
 * after an Item is created). Any other error propagates immediately.
 */
async function waitForTransactions(
  adapter: PlaidAdapter,
  userId: string,
  accountId: string
): Promise<Transaction[]> {
  let lastError: unknown
  for (let attempt = 1; attempt <= SYNC_POLL_ATTEMPTS; attempt++) {
    try {
      return await adapter.getTransactions(userId, accountId)
    } catch (error) {
      lastError = error
      if (!isProductNotReady(error) || attempt === SYNC_POLL_ATTEMPTS) {
        throw error
      }
      await sleep(SYNC_POLL_INTERVAL_MS)
    }
  }
  // Unreachable, but keeps TypeScript happy about the return type.
  throw lastError
}

function isProductNotReady(error: unknown): boolean {
  if (error instanceof ProviderUnavailableError) {
    return error.message.includes('PRODUCT_NOT_READY')
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
