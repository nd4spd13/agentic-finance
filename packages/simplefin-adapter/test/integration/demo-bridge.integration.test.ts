/**
 * SimpleFIN demo Bridge integration test (SF7).
 *
 * Exercises `SimpleFinAdapter` end to end against the REAL public SimpleFIN
 * demo Bridge (`https://beta-bridge.simplefin.org`) — no fakes, no fixtures.
 * This is the one test file in this package that makes outbound network
 * calls (mirrors `packages/plaid-adapter/test/integration/sandbox.integration.test.ts`).
 *
 * Gated behind `SIMPLEFIN_INTEGRATION=1` so `pnpm test` stays green (and this
 * file reports as *skipped*, not failed) on any machine that hasn't opted
 * in — including CI. Unlike the Plaid sandbox test, no credentials are
 * required (the demo Bridge is public), so the gate is a plain opt-in flag
 * rather than a check for configured secrets — this test must never run
 * silently as a side effect of a bare `pnpm test`/`vitest run`. To actually
 * run it locally:
 *
 *   SIMPLEFIN_INTEGRATION=1 pnpm --filter @clad/simplefin-adapter test:integration
 *
 * QUOTA DISCIPLINE: the demo Bridge shares a soft ~24-requests/day quota
 * across everyone using it (see the plan's "Rate limits" note). This suite
 * makes exactly:
 *   - 1 fetch of the developers guide page (a normal page load, not an
 *     `/accounts` API call — doesn't count against the quota per the SF1
 *     fixtures README's capture notes).
 *   - 1 one-time claim POST (consumes a fresh demo setup token; setup tokens
 *     are minted per page load, so this test always fetches its own rather
 *     than reusing any token copied into docs/fixtures).
 *   - Exactly 2 `GET /accounts` requests: the first is the adapter's cold-
 *     cache fetch; the second proves `SimpleFinCache`'s quota guardrail
 *     actually re-fetches once its (injected, fake-clocked) refresh interval
 *     has elapsed. Every other adapter call in between (`getAccounts` again,
 *     `getBalance`, `getTransactions`) is asserted to cost zero additional
 *     requests, proving the guardrail suppresses them. The clock is injected
 *     (`SimpleFinAdapterOptions.now`) so "6 hours later" is simulated
 *     in-process — this test never actually sleeps.
 * Total network cost: 1 page load + 1 claim + 2 `/accounts` fetches.
 *
 * All state (encrypted token store DB + SimpleFIN cache DB) lives in a temp
 * directory created for this run — nothing under `~/.clad` is touched.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqliteTokenStore } from '@clad/core'
import { SimpleFinAdapter } from '../../src/adapter.js'
import { claimSetupToken } from '../../src/claim.js'
import type { FetchLike } from '../../src/client.js'

const RUN_INTEGRATION = process.env.SIMPLEFIN_INTEGRATION === '1'

const DEMO_DEVELOPERS_URL = 'https://beta-bridge.simplefin.org/info/developers'
/** Matches the first `<pre class="code">...</pre>` block on the developers page, which embeds a fresh, ready-to-use demo setup token (confirmed live in SF1 — see the plan's protocol reference). */
const DEMO_TOKEN_PATTERN = /<pre class="code">\s*([\s\S]*?)\s*<\/pre>/

const TEST_TIMEOUT_MS = 60_000
const TEST_PASSPHRASE = 'sf7-demo-bridge-integration-test-passphrase'
const SIX_HOURS_MS = 6 * 60 * 60 * 1000

describe.runIf(RUN_INTEGRATION)('SimpleFinAdapter (SimpleFIN demo Bridge integration)', () => {
  let tmpDir: string
  let tokenDbPath: string
  let cacheDbPath: string
  let tokenStore: SqliteTokenStore

  // Instrumented fetch: counts requests by method/URL and forwards every
  // call to the real global `fetch` — never mocked, never stubbed. Used to
  // assert the exact request budget spelled out in the module doc comment
  // above (1 claim POST + at most 2 `/accounts` GETs).
  let claimRequestCount = 0
  let accountsRequestCount = 0
  const instrumentedFetch: FetchLike = (async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'POST') claimRequestCount += 1
    if (url.includes('/accounts')) accountsRequestCount += 1
    return globalThis.fetch(input, init)
  }) as FetchLike

  // Fake, controllable clock injected into the adapter (and forwarded to its
  // cache). Lets this test prove the 6h quota-guardrail interval actually
  // re-fetches once elapsed, without ever sleeping for 6 real hours.
  let currentTimeMs = Date.now()
  const fakeNow = (): Date => new Date(currentTimeMs)

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clad-simplefin-demo-it-'))
    tokenDbPath = join(tmpDir, 'simplefin-tokens.sqlite')
    cacheDbPath = join(tmpDir, 'simplefin-cache.sqlite')
    tokenStore = new SqliteTokenStore({ dbPath: tokenDbPath, passphrase: TEST_PASSPHRASE })
  })

  afterAll(() => {
    tokenStore?.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it(
    'claims a fresh demo setup token and reads mapped accounts/transactions through the cache-guardrailed adapter',
    async () => {
      // --- Step 1: fetch a FRESH demo setup token -------------------------
      // Plain, uninstrumented fetch: a normal page load, not an API call —
      // must not count toward the `/accounts` quota tracked above.
      const pageResponse = await fetch(DEMO_DEVELOPERS_URL)
      expect(pageResponse.ok).toBe(true)
      const html = await pageResponse.text()

      const match = DEMO_TOKEN_PATTERN.exec(html)
      expect(match, 'expected the developers page to embed a demo setup token').not.toBeNull()
      const setupToken = match![1].trim()
      expect(setupToken.length).toBeGreaterThan(0)

      // --- Step 2: claim it (one-time; 1 network POST) --------------------
      const accessUrl = await claimSetupToken(setupToken, { fetch: instrumentedFetch })
      expect(accessUrl).toMatch(/^https:\/\/[^:]+:[^@]+@beta-bridge\.simplefin\.org/)
      expect(claimRequestCount).toBe(1)

      // Deliberately avoids the substring "demo" anywhere it would land in
      // plaintext token-store columns (`item_id`/`institution_name`): the
      // Bridge's demo access URLs use a literal, shared `demo` HTTP basic
      // auth *username* (confirmed by this test's own first run — see the
      // credential-leak check below), so an item id/institution name
      // containing that word would false-positive against the very
      // assertion meant to catch a real leak.
      const itemId = 'sf7-integration-item'
      tokenStore.saveItem({
        itemId,
        institutionName: 'SimpleFIN Bridge (public sandbox)',
        accessToken: accessUrl,
      })

      const adapter = new SimpleFinAdapter({
        tokenStore,
        dbPath: cacheDbPath,
        fetch: instrumentedFetch,
        now: fakeNow,
      })
      const userId = 'sf7-integration-user'

      // --- Step 3: cold cache -> exactly one live `/accounts` fetch -------
      const accounts = await adapter.getAccounts(userId)
      expect(Array.isArray(accounts)).toBe(true)
      expect(accounts.length).toBeGreaterThan(0)
      for (const account of accounts) {
        expect(account.id.startsWith('simplefin:')).toBe(true)
        expect(typeof account.name).toBe('string')
        expect(['checking', 'savings', 'credit', 'loan', 'investment']).toContain(account.type)
        expect(typeof account.balance_current).toBe('number')
        expect(Number.isFinite(account.balance_current)).toBe(true)
        expect(typeof account.currency).toBe('string')
      }
      expect(accountsRequestCount).toBe(1)

      const accountId = accounts[0].id

      // --- Step 4: getBalance immediately after -> guardrail suppresses --
      // the network call entirely; served from the cache just populated.
      const balance = await adapter.getBalance(userId, accountId)
      expect(balance.account_id).toBe(accountId)
      expect(typeof balance.current).toBe('number')
      expect(typeof balance.currency).toBe('string')
      expect(typeof balance.last_updated).toBe('string')
      expect(accountsRequestCount).toBe(1)

      // --- Step 5: getTransactions -> same guardrail, same zero cost -----
      const transactions = await adapter.getTransactions(userId, accountId)
      expect(Array.isArray(transactions)).toBe(true)
      for (const txn of transactions) {
        expect(typeof txn.id).toBe('string')
        expect(txn.account_id).toBe(accountId)
        expect(typeof txn.amount).toBe('number')
        expect(Number.isFinite(txn.amount)).toBe(true)
        expect(typeof txn.date).toBe('string')
        expect(typeof txn.description).toBe('string')
        expect(typeof txn.pending).toBe('boolean')
      }
      expect(accountsRequestCount).toBe(1)

      // --- Step 6: getAccounts again, same instant -> still cached -------
      const accountsAgain = await adapter.getAccounts(userId)
      expect(accountsAgain.length).toBe(accounts.length)
      expect(accountsRequestCount).toBe(1)

      // --- Step 7: advance the injected clock past the 6h guardrail ------
      // window -> exactly one more live fetch, proving the guardrail is not
      // just "never refetch" but "refetch when actually due."
      currentTimeMs += SIX_HOURS_MS + 60_000
      const accountsAfterInterval = await adapter.getAccounts(userId)
      expect(accountsAfterInterval.length).toBeGreaterThan(0)
      expect(accountsRequestCount).toBe(2)

      // --- Step 8: quota discipline for the whole suite run ---------------
      expect(claimRequestCount).toBe(1)
      expect(accountsRequestCount).toBeLessThanOrEqual(2)

      // --- Step 9: the access URL's credentials are never on disk in the --
      // clear — SqliteTokenStore encrypts at rest (AES-256-GCM).
      const credentialedUrl = new URL(accessUrl)
      const raw = readFileSync(tokenDbPath)
      expect(raw.toString('utf8')).not.toContain(credentialedUrl.username)
      expect(raw.toString('latin1')).not.toContain(credentialedUrl.username)
      expect(raw.toString('utf8')).not.toContain(credentialedUrl.password)
      expect(raw.toString('latin1')).not.toContain(credentialedUrl.password)
    },
    TEST_TIMEOUT_MS
  )
})
