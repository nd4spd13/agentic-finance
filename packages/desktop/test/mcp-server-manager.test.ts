/**
 * Integration-style tests: these spawn a REAL `@clad/mcp-server` dummy-
 * provider child process (same technique the S0.4 spike proved out) rather
 * than mocking `child_process`/the SDK transport — the manager constructs
 * `StdioClientTransport`/`Client` directly, so a mock at that boundary would
 * mostly be testing the mock. The one thing NOT covered here is the full
 * exponential-backoff *timing* across many attempts (would make the suite
 * slow/flaky); `computeBackoffDelayMs`'s math is covered directly in
 * `mcp-backoff.test.ts`, and the live crash-loop behavior is a manual/
 * packaged-app QA step (see the D1 manual QA notes in desktop-app.md).
 *
 * D5.3 Wave 6 (the flag flip): `CLAD_MCP_AUTH=oauth` is now ALWAYS set for
 * this child (`buildServerEnv`), so (a) every `makeDummyConfig` caller needs
 * a `grant_db` path and a real passphrase (`getActivePassphrase` can no
 * longer return `null` for a test that expects `state: 'running'`), and (b)
 * `callToolOverLoopback` can no longer connect with no `Authorization`
 * header at all — `/mcp` 401s unauthenticated requests unconditionally now.
 * `obtainAccessToken` below drives the FULL real OAuth dance (DCR ->
 * authorize -> the real consent decision route -> token) against the child's
 * now-always-on resource server to get a real Bearer token bound to a given
 * profile, mirroring `packages/mcp-server/test/oauth/oauth-flow.test.ts`'s
 * `realConsentResources` suite — the reference this was ported from.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import http, { type IncomingHttpHeaders } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServerManager } from '../src/main/lib/mcp-server-manager.js'
import { savePolicyAndRestartServer } from '../src/main/lib/policy-save.js'
import type { CladConfig } from '../src/main/lib/config.js'

/** The test passphrase used everywhere a real grant store / dummy-provider run needs one — same convention as the pre-existing 'a-test-passphrase' used below for the simplefin test. */
const TEST_PASSPHRASE = 'a-test-passphrase'
/** Never actually visited — `decide()` reads the redirect's `code` off the raw HTTP response instead of following it. */
const OAUTH_REDIRECT = 'https://example.com/callback'

/**
 * Grabs a free loopback port so these tests don't collide with the fixed
 * `DEFAULT_MCP_HTTP_PORT` (8765) a developer might have in use, and so
 * separate test files can run in parallel workers without fighting over one
 * port. The manager reads `CLAD_MCP_HTTP_PORT` at spawn time (see
 * `resolveMcpHttpPort`), so setting it in `beforeEach` is enough.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Parses the `request_id` and `csrf_token` hidden fields out of a rendered consent page (`consent-http.ts`'s `renderConsentPage`). */
function parseConsentPage(html: string): { requestId: string; csrfToken: string } {
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1]
  const csrfToken = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1]
  if (!requestId || !csrfToken) throw new Error('consent page did not render the expected hidden fields')
  return { requestId, csrfToken }
}

/** Raw `node:http` request so a cross-origin 302 `Location` (`OAUTH_REDIRECT`) can be read without `fetch`'s opaque-redirect handling — same technique `oauth-flow.test.ts` uses. */
function rawRequest(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') })
        )
      }
    )
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/**
 * Drives the FULL real OAuth dance — DCR (`POST /register`) -> `GET
 * /authorize` (renders the real consent page) -> `POST /authorize/decision`
 * (approve, binding `profileId`) -> `POST /token` — against the supervised
 * child's now-always-on resource server, exactly the path `mcp-remote` takes
 * in production once Wave 6 flips the flag. Returns a real Bearer access
 * token so `callToolOverLoopback` can authenticate as a specific agent.
 * `profileId` MUST be a real agent name in the policy the child was started
 * with, or the consent decision 302s to an `access_denied` error instead of
 * a code.
 */
async function obtainAccessToken(port: number, profileId: string): Promise<string> {
  const registerRes = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [OAUTH_REDIRECT], token_endpoint_auth_method: 'none' }),
  })
  const client = (await registerRes.json()) as { client_id: string }

  const { verifier, challenge } = pkce()
  const state = `state-${randomBytes(8).toString('hex')}`
  const authorizeQuery = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: OAUTH_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString()
  const rendered = await rawRequest(port, `/authorize?${authorizeQuery}`)
  if (rendered.status !== 200) {
    throw new Error(`GET /authorize did not render the consent page (status ${rendered.status}): ${rendered.body}`)
  }
  const { requestId, csrfToken } = parseConsentPage(rendered.body)

  const decision = await rawRequest(port, '/authorize/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      request_id: requestId,
      csrf_token: csrfToken,
      state,
      decision: 'approve',
      profile_id: profileId,
    }).toString(),
  })
  if (decision.status !== 302 || !decision.headers.location) {
    throw new Error(`POST /authorize/decision did not redirect (status ${decision.status}): ${decision.body}`)
  }
  const location = new URL(decision.headers.location)
  const code = location.searchParams.get('code')
  if (!code) {
    throw new Error(`/authorize/decision redirect carried no code (error=${location.searchParams.get('error')})`)
  }

  const tokenRes = await fetch(`http://127.0.0.1:${port}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: OAUTH_REDIRECT,
    }).toString(),
  })
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string }
  if (!tokenJson.access_token) {
    throw new Error(`POST /token did not return an access_token: ${JSON.stringify(tokenJson)}`)
  }
  return tokenJson.access_token
}

const POLICY_YAML = `
agents:
  default-agent:
    description: D1.2 manager test — dummy provider
    permissions:
      accounts:
        visible:
          - acc_checking_001
          - acc_savings_001
          - acc_credit_001
        balance: true
        account_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 30
      audit:
        log_all_queries: true
        log_policy_evaluations: true
        retention: 90d

global:
  max_total_daily_spend: 10000
  max_concurrent_agents: 5
  require_human_approval_above: 1000
  default_escalation_timeout: 300
`

/**
 * The v0.5.0 repro shape: a realistic user-edited policy with NO
 * `default-agent` in it at all. `analyst` may see balances, `finance-agent`
 * may not — a per-agent difference that a tool call can observe, which is how
 * the identity tests below prove the child really is running as the agent it
 * claims rather than merely reporting one.
 */
const NO_DEFAULT_AGENT_POLICY_YAML = `
agents:
  analyst:
    description: Repro policy — may read balances.
    permissions:
      accounts:
        visible: []
        balance: true
        account_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 30
      audit:
        log_all_queries: true
        log_policy_evaluations: true
  finance-agent:
    description: Repro policy — may NOT read balances.
    permissions:
      accounts:
        visible: []
        balance: false
        account_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 30
      audit:
        log_all_queries: true
        log_policy_evaluations: true
`

function makeDummyConfig(dir: string, policyYaml: string = POLICY_YAML): CladConfig {
  writeFileSync(join(dir, 'policy.yaml'), policyYaml, 'utf-8')
  return {
    policy_path: join(dir, 'policy.yaml'),
    audit_db: join(dir, 'audit.sqlite'),
    approval_db: join(dir, 'approvals.sqlite'),
    server_pid_file: join(dir, 'server.pid'),
    provider: 'dummy',
    plaid_db: join(dir, 'plaid.sqlite'),
    plaid_env: 'sandbox',
    close_to_tray: true,
    simplefin_db: join(dir, 'simplefin.sqlite'),
    // D5.3 Wave 6: CLAD_MCP_AUTH=oauth is now always on, so the child always
    // opens a real SqliteGrantStore at this path — every test below needs it,
    // not just OAuth-specific ones.
    grant_db: join(dir, 'grants.sqlite'),
    agent_id: '',
  }
}

/**
 * Clients opened by `callToolOverLoopback`, closed in `afterEach` BEFORE the
 * manager stops its child — same single-`client.close()` teardown
 * `packages/mcp-server/test/http-transport.test.ts` uses. Closing them after
 * the child is gone aborts an in-flight SSE read against a dead socket, which
 * surfaces as an unhandled `setTypeOfService EINVAL` from undici.
 */
const loopbackClients: Client[] = []

/** Must be called before anything kills the child a client is attached to. */
async function closeLoopbackClients(): Promise<void> {
  for (const client of loopbackClients.splice(0)) {
    await client.close().catch(() => undefined)
  }
}

/**
 * Calls a tool over the loopback HTTP server as an INDEPENDENT client —
 * exactly the path Claude Desktop's `mcp-remote` proxy takes (the manager's
 * own readiness probe is a plain unauthenticated `fetch`, not a persistent
 * client, as of D5.3 Wave 6 — see `mcp-server-manager.ts`'s READINESS & CRASH
 * DETECTION doc comment). Deliberately not routed through the manager: the
 * regression these tests guard is about what a third-party client's tool call
 * gets back, and the manager never exposed a `callTool` for one to hide
 * behind.
 *
 * D5.3 Wave 6: `/mcp` now 401s any request with no valid Bearer token, so
 * `bearer` is REQUIRED — obtain one with `obtainAccessToken` first, bound to
 * whichever profile the call should run as (that binding, not this
 * function's `toolName` argument, is what the policy engine evaluates
 * against post-flip).
 */
async function callToolOverLoopback(
  toolName: string,
  bearer: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const url = new URL(`http://127.0.0.1:${process.env.CLAD_MCP_HTTP_PORT}/mcp`)
  const client = new Client({ name: 'clad-desktop-test-client', version: '0.0.0' }, { capabilities: {} })
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } })
  )
  loopbackClients.push(client)
  const result = (await client.callTool({ name: toolName, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>
  }
  return (result.content ?? []).map((part) => part.text ?? '').join('\n')
}

/** The port the manager's child is (or will be) listening on for the CURRENT test — `obtainAccessToken`/`callToolOverLoopback` both key off this, same as `beforeEach` setting it and the "changed agent_id" tests re-setting it before a restart. */
function currentPort(): number {
  return Number(process.env.CLAD_MCP_HTTP_PORT)
}

async function waitFor(predicate: () => boolean, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 50 } = opts
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

let dir: string | undefined
let manager: McpServerManager | undefined
let prevHttpPort: string | undefined

beforeEach(async () => {
  prevHttpPort = process.env.CLAD_MCP_HTTP_PORT
  process.env.CLAD_MCP_HTTP_PORT = String(await getFreePort())
})

afterEach(async () => {
  await closeLoopbackClients() // before manager.stop() — see `loopbackClients`
  if (manager) {
    await manager.stop()
    manager = undefined
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
  if (prevHttpPort === undefined) delete process.env.CLAD_MCP_HTTP_PORT
  else process.env.CLAD_MCP_HTTP_PORT = prevHttpPort
})

describe('McpServerManager', () => {
  it('start() spawns a real dummy-provider server and reaches "running" with tools listed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => TEST_PASSPHRASE,
      onStatusChange: () => undefined,
    })

    const status = await manager.start()

    expect(status.state).toBe('running')
    expect(typeof status.pid).toBe('number')
    expect(status.tools).toContain('clad_get_balances')
    expect(status.tools.length).toBeGreaterThan(0)
  }, 10_000)

  it('stop() cleanly returns to "stopped" with no pid', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => TEST_PASSPHRASE,
      onStatusChange: () => undefined,
    })
    await manager.start()

    const status = await manager.stop()

    expect(status.state).toBe('stopped')
    expect(status.pid).toBeUndefined()
  }, 10_000)

  it('start() is a no-op while already running (does not spawn a second process)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => TEST_PASSPHRASE,
      onStatusChange: () => undefined,
    })
    const first = await manager.start()

    const second = await manager.start()

    expect(second.pid).toBe(first.pid)
  }, 10_000)

  // D5.3 Wave 6: this ISOLATES the credentials-missing case (a real
  // passphrase is supplied) — before Wave 6 this test also had no
  // passphrase, so the two failure causes were conflated; the passphrase is
  // now a SEPARATE pre-flight check (see the dedicated test for it below),
  // so this one only fails for the reason its name says it does.
  it('fails fast with a clear error when provider=plaid but credentials are missing (no process spawned)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config: CladConfig = { ...makeDummyConfig(dir), provider: 'plaid' }
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => TEST_PASSPHRASE,
      onStatusChange: () => undefined,
    })

    const status = await manager.start()

    expect(status.state).toBe('crashed')
    expect(status.pid).toBeUndefined()
    expect(status.lastError).toMatch(/credentials/i)
  }, 10_000)

  it('fails fast with a clear error when provider=simplefin but the passphrase is missing (no process spawned)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config: CladConfig = { ...makeDummyConfig(dir), provider: 'simplefin' }
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      onStatusChange: () => undefined,
    })

    const status = await manager.start()

    expect(status.state).toBe('crashed')
    expect(status.pid).toBeUndefined()
    expect(status.lastError).toMatch(/passphrase/i)
  }, 10_000)

  /**
   * D5.3 Wave 6 NEW invariant: `CLAD_MCP_AUTH=oauth` boot-throws inside
   * `loadOAuthResources` without `CLAD_TOKEN_PASSPHRASE`, regardless of
   * provider — including 'dummy', which (unlike plaid/simplefin) never
   * needed a passphrase for its OWN provider construction before this. This
   * is the exact "would have shipped a silent crash-loop" case the flag flip
   * has to pre-flight, mirroring the plaid/simplefin checks above rather
   * than letting the child boot-throw with no clear status surfaced.
   */
  it('fails fast with a clear error for the DUMMY provider when the passphrase is missing (D5.3 Wave 6 — the grant store always needs one now)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      onStatusChange: () => undefined,
    })

    const status = await manager.start()

    expect(status.state).toBe('crashed')
    expect(status.pid).toBeUndefined()
    expect(status.lastError).toMatch(/passphrase/i)
  }, 10_000)

  it('start() spawns a real simplefin-provider server (passphrase only, no Plaid credentials needed) and reaches "running" with tools listed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config: CladConfig = { ...makeDummyConfig(dir), provider: 'simplefin' }
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => TEST_PASSPHRASE,
      onStatusChange: () => undefined,
    })

    const status = await manager.start()

    expect(status.state).toBe('running')
    expect(typeof status.pid).toBe('number')
    expect(status.tools).toContain('clad_get_balances')
  }, 10_000)

  it('detects an unexpected process exit and auto-restarts with a new process', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    const states: string[] = []
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => TEST_PASSPHRASE,
      onStatusChange: (status) => states.push(status.state),
    })
    const running = await manager.start()
    expect(running.pid).toBeDefined()

    process.kill(running.pid!, 'SIGKILL')

    await waitFor(() => states.includes('crashed'), { timeoutMs: 5000 })

    // Backoff attempt 0 is ~1s (BACKOFF_BASE_MS) — give it real time to fire
    // and spawn a replacement process automatically, with no manual start().
    await waitFor(() => manager!.getStatus().state === 'running' && manager!.getStatus().pid !== running.pid, {
      timeoutMs: 8000,
    })
    expect(manager.getStatus().restartAttempt).toBeGreaterThanOrEqual(1)
  }, 15_000)

  /**
   * v0.5.0 REGRESSION SUITE. `buildServerEnv` set no `CLAD_AGENT_ID`, so the
   * supervised child fell back to `server-core.ts`'s hardcoded
   * `'default-agent'`. That was invisible while the child only ever served
   * `tools/list` (which never consults policy), and became "every Claude
   * Desktop tool call is denied" the moment PR #68 routed those calls here.
   *
   * The first test below is the one whose absence let the bug ship: every
   * pre-existing manager test used a policy that happened to define
   * `default-agent`, and none of them called a policy-consulting tool.
   *
   * D5.3 Wave 6 UPDATE: `getRunningAgentId()`/`CLAD_AGENT_ID` resolution
   * itself is UNCHANGED by the flag flip (still real, still tested below),
   * but it no longer determines what identity a real (authenticated) tool
   * call runs under — see `mcp-server-manager.ts`'s and
   * `claude-desktop-config.ts`'s doc comments. Every `callToolOverLoopback`
   * below now authenticates via `obtainAccessToken`, bound to whichever
   * profile the test is actually asserting about, since an unauthenticated
   * call now 401s outright instead of falling back to `CLAD_AGENT_ID`. The
   * new "vestigial" test at the end of this block proves that directly.
   */
  describe('agent identity', () => {
    it('REGRESSION: a tool call against a policy with NO default-agent succeeds instead of being denied for an unknown agent', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      // agent_id unset, exactly like every config.json written before the
      // field existed — the child must still resolve a REAL policy agent.
      const config = makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML)
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => TEST_PASSPHRASE,
        onStatusChange: () => undefined,
      })
      await manager.start()
      // Deterministic sorted-first resolution, and a real agent in the policy.
      expect(manager.getRunningAgentId()).toBe('analyst')

      // A real, OAuth-consented profile succeeds — proves the running child
      // serves a genuine policy agent, not a hardcoded 'default-agent' that
      // doesn't exist in this policy.
      const token = await obtainAccessToken(currentPort(), 'analyst')
      const text = await callToolOverLoopback('clad_get_balances', token)
      expect(text).not.toMatch(/unknown agent/i)
      expect(text).not.toMatch(/^Denied:/)
    }, 15_000)

    /**
     * D5.3 Wave 6: THE direct proof that `CLAD_AGENT_ID` (this configured
     * `agent_id`) no longer governs a real client's tool-call identity.
     * `config.agent_id` is set to 'finance-agent' (denied balance
     * visibility) — if the old fallback mechanism were still in effect, a
     * client authenticated as 'analyst' would somehow still end up evaluated
     * as 'finance-agent'. It doesn't: the OAuth-bound profile wins, exactly
     * as `resolvePrincipal` (`server-core.ts`) is written to do once
     * `authRequired` is unconditionally true for this transport.
     */
    it("a client's OAuth-bound profile governs its tool calls, NOT the child's configured agent_id (D5.3 Wave 6)", async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'finance-agent' }
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => TEST_PASSPHRASE,
        onStatusChange: () => undefined,
      })
      await manager.start()
      // The child DOES still assert 'finance-agent' as CLAD_AGENT_ID...
      expect(manager.getRunningAgentId()).toBe('finance-agent')

      // ...but a client that consented as 'analyst' (balance-visible) still
      // sees balances — 'finance-agent's denial never applies to it.
      const analystToken = await obtainAccessToken(currentPort(), 'analyst')
      const analystText = await callToolOverLoopback('clad_get_balances', analystToken)
      expect(analystText).not.toMatch(/balance visibility disabled/i)
      expect(analystText).not.toMatch(/unknown agent/i)

      // A DIFFERENT client that consented as 'finance-agent' IS denied —
      // proving the denial tracks the OAuth-bound profile, not a
      // process-wide identity every client would otherwise share.
      const financeToken = await obtainAccessToken(currentPort(), 'finance-agent')
      const financeText = await callToolOverLoopback('clad_get_balances', financeToken)
      expect(financeText).toMatch(/balance visibility disabled/i)
    }, 15_000)

    it('a changed agent_id still takes effect on restart for getRunningAgentId (the status-panel/UI-facing value), and OAuth keeps serving real profiles across it', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'analyst' }
      manager = new McpServerManager({
        // Mutable, re-read on every spawn — models the real deps object,
        // which calls loadConfig() fresh each time.
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => TEST_PASSPHRASE,
        onStatusChange: () => undefined,
      })
      await manager.start()
      expect(manager.getRunningAgentId()).toBe('analyst')
      const tokenBefore = await obtainAccessToken(currentPort(), 'analyst')
      expect(await callToolOverLoopback('clad_get_balances', tokenBefore)).not.toMatch(/^Denied:/)

      config.agent_id = 'finance-agent'
      await closeLoopbackClients() // the restart below kills the child they're attached to
      // Point the restarted child at a fresh port (the manager re-resolves it
      // per spawn). Purely test isolation: `fetch`'s connection pool would
      // otherwise reuse the keep-alive socket it opened to the OLD child,
      // which the restart has since killed, and writing to that dead socket
      // surfaces as an unhandled `setTypeOfService EINVAL` from undici. The
      // real app keeps one fixed port across restarts — see
      // `DEFAULT_MCP_HTTP_PORT` — and its clients reconnect rather than
      // holding a pooled socket across a child's lifetime.
      process.env.CLAD_MCP_HTTP_PORT = String(await getFreePort())
      await manager.restart()

      // getRunningAgentId still reflects the new configured value (UNCHANGED
      // behaviour — this is still what the status panel/UI reads).
      expect(manager.getRunningAgentId()).toBe('finance-agent')
      // The restarted child's OAuth resource server works correctly too — a
      // FRESH grant (the old grant store file, same passphrase) still serves
      // a real profile's tool call post-restart.
      const tokenAfter = await obtainAccessToken(currentPort(), 'analyst')
      expect(await callToolOverLoopback('clad_get_balances', tokenAfter)).not.toMatch(/^Denied:/)
    }, 20_000)

    it('surfaces a clear lastError (instead of silently denying everything) when the configured agent is not in the policy', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'deleted-agent' }
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => TEST_PASSPHRASE,
        onStatusChange: () => undefined,
      })

      const status = await manager.start()

      // Still running (a policy typo shouldn't cost the user their server),
      // but the reason is visible in the status surface the UI renders.
      expect(status.state).toBe('running')
      expect(status.lastError).toContain('deleted-agent')
      // A genuine misconfiguration keeps using the "problem" slot, not the
      // informational one added for the implicit-default-choice case below.
      expect(status.agentNotice).toBeUndefined()
      // ...and it fell back to a real agent rather than denying everything.
      expect(manager.getRunningAgentId()).toBe('analyst')
      // A real client's tool call is unaffected by the deleted-agent
      // fallback misconfiguration — it's evaluated under its OWN
      // OAuth-consented profile, not the (broken) configured one.
      const token = await obtainAccessToken(currentPort(), 'analyst')
      expect(await callToolOverLoopback('clad_get_balances', token)).not.toMatch(/unknown agent/i)
    }, 15_000)

    it('surfaces the implicit-default choice via agentNotice, NOT lastError, when no agent is configured and the policy defines several', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      // agent_id unset (from makeDummyConfig's default) + NO_DEFAULT_AGENT_POLICY_YAML
      // defines two agents — the exact "gap" case: nothing is broken, but the
      // running identity was picked by string sort order, not a user choice.
      const config = makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML)
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => TEST_PASSPHRASE,
        onStatusChange: () => undefined,
      })

      const status = await manager.start()

      expect(status.state).toBe('running')
      // Healthy server, not a problem — must NOT land in the "something is
      // wrong" slot the status panel renders as an error.
      expect(status.lastError).toBeUndefined()
      expect(status.agentNotice).toContain('analyst')
      expect(status.agentNotice).toContain('finance-agent')
      expect(manager.getRunningAgentId()).toBe('analyst')
      const token = await obtainAccessToken(currentPort(), 'analyst')
      expect(await callToolOverLoopback('clad_get_balances', token)).not.toMatch(/^Denied:/)
    }, 15_000)

    it('getRunningAgentId is null once stopped', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'analyst' }
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => TEST_PASSPHRASE,
        onStatusChange: () => undefined,
      })
      await manager.start()
      expect(manager.getRunningAgentId()).toBe('analyst')

      await manager.stop()

      expect(manager.getRunningAgentId()).toBeNull()
    }, 15_000)

    it('D5.3 Wave 6: an unauthenticated tool call is rejected outright — it never silently runs as the configured agent_id', async () => {
      dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
      const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'analyst' }
      manager = new McpServerManager({
        loadConfig: () => config,
        loadPlaidCredentials: () => null,
        getActivePassphrase: () => TEST_PASSPHRASE,
        onStatusChange: () => undefined,
      })
      await manager.start()
      expect(manager.getRunningAgentId()).toBe('analyst')

      // No Authorization header at all — the pre-Wave-6 behaviour this
      // exact call shape used to exercise was "falls back to CLAD_AGENT_ID
      // (analyst) and succeeds". Post-Wave-6 it must instead be rejected by
      // the transport before ever reaching a tool handler.
      const url = new URL(`http://127.0.0.1:${currentPort()}/mcp`)
      const client = new Client({ name: 'clad-desktop-test-client-unauth', version: '0.0.0' }, { capabilities: {} })
      await expect(client.connect(new StreamableHTTPClientTransport(url))).rejects.toBeTruthy()
      await client.close().catch(() => undefined)
    }, 15_000)
  })
})

/**
 * CLAD-5 integration coverage: `policy-save.test.ts` proves the restart
 * DECISION logic against a fake `McpRestartHandle`; this proves the real
 * end-to-end fix — that a policy write followed by
 * `savePolicyAndRestartServer`'s restart actually reaches a running
 * supervised child (goes through `McpServerManager.restart()`, exactly like
 * PR #71's manual/auto-restart paths — no hand-rolled spawn) instead of
 * being silently held in the old child's memory until the next app relaunch.
 */
describe('savePolicyAndRestartServer (integration, real supervised child)', () => {
  it('a saved policy change is served by the restarted child, not the old in-memory one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config: CladConfig = { ...makeDummyConfig(dir, NO_DEFAULT_AGENT_POLICY_YAML), agent_id: 'analyst' }
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => TEST_PASSPHRASE,
      onStatusChange: () => undefined,
    })
    await manager.start()
    // Baseline: 'analyst' may currently read balances per NO_DEFAULT_AGENT_POLICY_YAML.
    const tokenBefore = await obtainAccessToken(currentPort(), 'analyst')
    expect(await callToolOverLoopback('clad_get_balances', tokenBefore)).not.toMatch(/balance visibility disabled/i)

    const updatedPolicy = {
      agents: {
        analyst: {
          description: 'Repro policy — may read balances.',
          permissions: {
            accounts: { visible: [], balance: false, account_number: false },
            transactions: { read: true, description_visibility: true, lookback_days: 30 },
            audit: { log_all_queries: true, log_policy_evaluations: true },
          },
        },
        'finance-agent': {
          description: 'Repro policy — may NOT read balances.',
          permissions: {
            accounts: { visible: [], balance: false, account_number: false },
            transactions: { read: true, description_visibility: true, lookback_days: 30 },
            audit: { log_all_queries: true, log_policy_evaluations: true },
          },
        },
      },
    }

    await closeLoopbackClients() // the restart below kills the child they're attached to
    // Fresh port for the same test-isolation reason as the "changed agent_id"
    // test above — the real app keeps one fixed port across restarts.
    process.env.CLAD_MCP_HTTP_PORT = String(await getFreePort())

    const result = await savePolicyAndRestartServer(config.policy_path, updatedPolicy, manager)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.server_restarted).toBe(true)
      expect(result.restart_error).toBeUndefined()
    }
    expect(manager.getRunningAgentId()).toBe('analyst')
    // Observable proof the RESTARTED child is serving the NEW policy content,
    // not the old child's in-memory copy from before the save. A fresh token
    // is required: the restart killed the child the old grant/session lived
    // on (a new SqliteGrantStore file handle, same store/passphrase).
    const tokenAfter = await obtainAccessToken(currentPort(), 'analyst')
    expect(await callToolOverLoopback('clad_get_balances', tokenAfter)).toMatch(/balance visibility disabled/i)
  }, 20_000)

  it('does not restart (or touch) a deliberately-stopped server, and reports server_restarted: false', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-manager-test-'))
    const config = makeDummyConfig(dir)
    manager = new McpServerManager({
      loadConfig: () => config,
      loadPlaidCredentials: () => null,
      getActivePassphrase: () => null,
      onStatusChange: () => undefined,
    })
    // Never started — models a user who has the server deliberately off.
    expect(manager.getRunningAgentId()).toBeNull()

    const result = await savePolicyAndRestartServer(
      config.policy_path,
      { agents: { 'default-agent': { description: 'x', permissions: {} } } },
      manager
    )

    expect(result).toEqual({ ok: true, server_restarted: false })
    expect(manager.getStatus().state).toBe('stopped')
  })
})
