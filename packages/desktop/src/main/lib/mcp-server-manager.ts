/**
 * Productionizes the S0.4 spike (`src/main/spike/mcp-handshake.ts`, now
 * removed) into a real start/stop/restart lifecycle with crash detection
 * and capped backoff, per D1.2.
 *
 * D5.3 WS1 (interim "3 dummy accounts" fix): the supervised child now runs in
 * loopback **HTTP** mode (`CLAD_MCP_TRANSPORT=http`), not stdio. The manager
 * therefore spawns the child process itself (`child_process.spawn`) with the
 * passphrase/provider env already injected (`buildServerEnv` with the
 * `http` transport option).
 *
 * Why HTTP: unlike a `StdioServerTransport` (which can only usefully serve one
 * client for its process lifetime — closing the verifying client's transport
 * terminates the child), an HTTP server serves many clients concurrently. So
 * the manager's own readiness probe AND Claude Desktop's `mcp-remote` client
 * can both reach the same already-unlocked child — which is the whole point
 * of the fix (real provider data reaches Claude Desktop with zero secrets in
 * any config file; see `claude-desktop-config.ts` and `@clad/mcp-server`'s
 * `http-transport.ts`).
 *
 * AGENT IDENTITY (v0.5.0 regression fix): because Claude Desktop's calls are
 * now served by THIS child rather than by a server Claude Desktop spawned
 * itself, this child's single env-asserted `CLAD_AGENT_ID` is the identity
 * every one of those calls is evaluated under. It is resolved fresh on every
 * spawn from `config.agent_id` + the policy (`resolveSupervisedAgentId`), so
 * a changed selection takes effect on the next start()/restart() — and
 * `getRunningAgentId()` lets callers detect when a restart is actually
 * needed. Leaving it unset (what shipped in v0.5.0) meant the child fell back
 * to `'default-agent'` and denied everything; see `config.ts`'s `agent_id`.
 *
 * KNOWN LIMITATION (until D5.3/WS3): one child == one identity == one shared
 * policy identity for EVERY MCP client that connects through the loopback
 * server. Claude Desktop and Claude Code connected at the same time are
 * indistinguishable to the policy engine. Per-connection authenticated
 * identity is D5.3's WS3 (`.claude/plans/D5.3-authenticated-agent-identity-plan.md`).
 *
 * READINESS & CRASH DETECTION (rewritten D5.3 Wave 6 — the flag flip):
 * before Wave 6, readiness opened a persistent, UNAUTHENTICATED
 * `@modelcontextprotocol/sdk` `Client`/`StreamableHTTPClientTransport`
 * session to the child and called `listTools()`; that session's `onclose`
 * doubled as a secondary crash signal, and its `listTools()` result
 * populated `McpProcessStatus.tools`. Wave 6 sets `CLAD_MCP_AUTH=oauth`
 * unconditionally for this transport (`buildServerEnv`), which mounts
 * `requireBearerAuth` in front of `/mcp` (`http-app.ts`) — an unauthenticated
 * MCP session can no longer be opened AT ALL, by design, including this
 * manager's own. Minting the manager a real OAuth grant would mean either a
 * synthetic client polluting the human-facing Connected-clients list (WS4
 * §4) or a new internal-token-bootstrap mechanism neither WS2 nor WS4 spec'd
 * — both out of scope for a flag flip. Instead:
 *  - Readiness (`waitForHttpReadiness`) is now a plain, unauthenticated
 *    `fetch` against `/mcp`. ANY HTTP response (401 once oauth is on, same
 *    as before if it's ever off) proves the child is up, bound to the port,
 *    passed the loopback-Host guard, AND successfully constructed its OAuth
 *    resources (`loadOAuthResources` — exactly the code path that
 *    boot-throws on a missing env var) — a STRONGER boot proof than the old
 *    authenticated round trip, which never touched that code path at all. A
 *    thrown `fetch` (connection refused) means the port isn't bound yet —
 *    the same "not ready, retry" case the old code handled.
 *  - `McpProcessStatus.tools` is populated from `SUPERVISED_CHILD_TOOL_NAMES`
 *    below (a literal copy of `@clad/mcp-server`'s `server-core.ts`'s fixed
 *    `tools` export — never policy/provider/agent-dependent, so a static
 *    list loses no fidelity; mirrors the existing "duplicate a small
 *    constant, keep it in sync" precedent `mcp-loopback.ts` already uses for
 *    `DEFAULT_MCP_HTTP_PORT` rather than statically importing the whole
 *    `@clad/mcp-server` provider/tool graph into the Electron main bundle).
 *  - The `onclose` secondary crash signal is RETIRED (it required the same
 *    persistent authenticated session that no longer exists). Crash
 *    detection is now solely the child process's own `exit`/`error` events —
 *    already documented as the "direct and reliable" PRIMARY signal below,
 *    unaffected by any of this.
 *
 * Crash detection: the child process's `exit`/`error` events. Readiness: an
 * unauthenticated HTTP probe against `/mcp`, retried until the child has
 * bound its port or a timeout elapses (see READINESS & CRASH DETECTION
 * above).
 *
 * State machine: stopped -> starting -> running -> stopping -> stopped, with
 * an unexpected exit from 'starting' or 'running' going to 'crashed'
 * instead, which schedules an auto-restart at an exponential, capped
 * backoff (see `computeBackoffDelayMs`) up to `MAX_AUTO_RESTART_ATTEMPTS`,
 * after which it gives up and waits for a manual start()/restart() from the
 * renderer. The attempt counter resets to 0 both on a manual start() and
 * after the server has stayed up longer than `BACKOFF_RESET_AFTER_MS`
 * (standard crash-loop backoff shape, e.g. systemd/k8s).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolveMcpServerEntry } from './mcp-server-path.js'
import { buildServerEnv, type McpSpawnSecrets } from './mcp-server-env.js'
import { resolveMcpHttpPort, mcpLoopbackUrl } from './mcp-loopback.js'
import { resolveSupervisedAgentId } from './agent-resolution.js'
import { getCladCore } from './clad-core.js'
import type { CladConfig } from './config.js'

/**
 * Mirror of `@clad/mcp-server`'s `server-core.ts` `tools` export's name list
 * — keep in sync. Process-constant (never varies by policy, provider, or
 * agent), so this loses no fidelity versus the pre-Wave-6 live `listTools()`
 * call it replaces as the source of `McpProcessStatus.tools` (see this
 * file's READINESS & CRASH DETECTION doc comment above for why a live call
 * is no longer possible).
 */
export const SUPERVISED_CHILD_TOOL_NAMES: readonly string[] = [
  'clad_get_balances',
  'clad_get_transactions',
  'clad_safe_to_spend',
  'clad_request_action',
  'clad_audit_log',
]

export type McpServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

/** Manager-internal status — process lifecycle only. `index.ts` merges this with a live pending-approvals count before it crosses IPC (see `McpServerStatus` in `shared/ipc.ts`). */
export interface McpProcessStatus {
  state: McpServerState
  pid?: number
  tools: string[]
  lastError?: string
  /**
   * Non-alarming counterpart to `lastError` — currently only the "no MCP
   * agent configured, picked one of several by default" notice (see
   * `SupervisedAgentResolution.warningIsInformational` in
   * `agent-resolution.ts`). Kept out of `lastError` deliberately: that field
   * is what the status UI renders as a problem (red text next to the state
   * dot), and this case is the opposite of a problem — a healthy server made
   * a default choice, and there's nothing to fix. Folding it into
   * `lastError` would misrepresent a normal running server as broken.
   */
  agentNotice?: string
  restartAttempt: number
}

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_FACTOR = 2
export const BACKOFF_CAP_MS = 30_000
/** After this many consecutive automatic restarts, stop trying and wait for a manual start()/restart(). */
export const MAX_AUTO_RESTART_ATTEMPTS = 5
/** A server that stays up at least this long resets the backoff attempt counter on its next crash. */
export const BACKOFF_RESET_AFTER_MS = 60_000

/** How long to keep retrying the HTTP readiness connection while the freshly-spawned child binds its loopback port. */
export const READINESS_TIMEOUT_MS = 10_000
/** Delay between HTTP readiness connection attempts. */
export const READINESS_POLL_INTERVAL_MS = 150

/** Exponential backoff, capped: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... */
export function computeBackoffDelayMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** attempt, BACKOFF_CAP_MS)
}

export interface McpServerManagerDeps {
  /** Resolves config fresh on every call, so edits made in Settings before Start/Restart are picked up. */
  loadConfig: () => CladConfig
  /** Null when Plaid credentials haven't been saved yet. */
  loadPlaidCredentials: () => { clientId: string; secret: string } | null
  /** Null when passphrase custody isn't resolved yet (e.g. CLI-migration prompt still pending). */
  getActivePassphrase: () => string | null
  onStatusChange: (status: McpProcessStatus) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class McpServerManager {
  private state: McpServerState = 'stopped'
  private child: ChildProcess | null = null
  private tools: string[] = []
  private lastError: string | undefined
  private restartAttempt = 0
  private expectedStop = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private upSince: number | null = null
  /** Bumped on every start()/stop(); lets a superseded in-flight spawn attempt detect it should discard its result instead of clobbering newer state. */
  private currentAttemptId = 0
  /** `CLAD_AGENT_ID` the currently-spawned child was started with; null while stopped. See `getRunningAgentId`. */
  private runningAgentId: string | null = null
  /**
   * Non-fatal agent-identity message from the last spawn (see
   * `SupervisedAgentResolution.warning`). Kept separate from `lastError` so a
   * real failure always wins the single `lastError` slot — `getStatus` falls
   * back to this only when there's no actual error, which is precisely the
   * dangerous case: a child that looks healthy but denies every tool call.
   */
  private agentIdWarning: string | undefined
  /**
   * Whether `agentIdWarning` is the informational "no agent configured,
   * defaulted to one of several" notice rather than an actual problem (see
   * `SupervisedAgentResolution.warningIsInformational`). Decides which of
   * `getStatus()`'s two output fields `agentIdWarning` surfaces through.
   */
  private agentIdWarningIsInformational = false

  constructor(private readonly deps: McpServerManagerDeps) {}

  getStatus(): McpProcessStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? undefined,
      tools: this.tools,
      lastError: this.lastError ?? (this.agentIdWarningIsInformational ? undefined : this.agentIdWarning),
      agentNotice: this.agentIdWarningIsInformational ? this.agentIdWarning : undefined,
      restartAttempt: this.restartAttempt,
    }
  }

  /**
   * The agent id the running child is actually asserting, or null when
   * nothing is running. Lets callers that change `config.agent_id` (the
   * connect flow in `main/index.ts`) tell whether the live child is now stale
   * and needs a restart — without that check, a changed selection would be
   * silently ignored until the next app launch, which is the same
   * "identity says one thing, process does another" failure this whole change
   * is about.
   */
  getRunningAgentId(): string | null {
    return this.runningAgentId
  }

  async start(): Promise<McpProcessStatus> {
    if (this.state === 'starting' || this.state === 'running') {
      return this.getStatus()
    }
    this.cancelPendingRestart()
    this.restartAttempt = 0
    await this.spawnAndConnect()
    return this.getStatus()
  }

  async stop(): Promise<McpProcessStatus> {
    this.cancelPendingRestart()
    this.currentAttemptId += 1 // invalidate any in-flight spawn attempt
    if (this.state === 'stopped' || this.state === 'stopping') {
      return this.getStatus()
    }
    this.expectedStop = true
    this.setState('stopping')
    await this.teardown()
    this.restartAttempt = 0
    this.setState('stopped')
    return this.getStatus()
  }

  async restart(): Promise<McpProcessStatus> {
    await this.stop()
    return this.start()
  }

  private setState(state: McpServerState): void {
    this.state = state
    this.deps.onStatusChange(this.getStatus())
  }

  private cancelPendingRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private async spawnAndConnect(): Promise<void> {
    this.expectedStop = false
    this.lastError = undefined
    this.agentIdWarning = undefined
    this.agentIdWarningIsInformational = false
    // Cleared up front so an early return below (missing credentials) can
    // never leave a previous run's identity looking current.
    this.runningAgentId = null
    this.currentAttemptId += 1
    const attemptId = this.currentAttemptId
    this.setState('starting')

    const config = this.deps.loadConfig()

    // D5.3 Wave 6: CLAD_MCP_AUTH=oauth is now ALWAYS set for this child
    // (`buildServerEnv`'s 'http' branch), and `server-core.ts`'s
    // `loadOAuthResources` boot-throws without `CLAD_TOKEN_PASSPHRASE`
    // regardless of `config.provider` — including 'dummy', which needs no
    // passphrase of its own for its OWN provider construction. Resolved
    // once, up front, for every provider branch below, so a 'dummy'-provider
    // spawn with no passphrase yet fails fast with a clear status HERE
    // (mirroring the existing plaid/simplefin pre-flight checks) instead of
    // silently spawning a child that boot-throws inside `loadOAuthResources`.
    const passphrase = this.deps.getActivePassphrase()
    if (!passphrase) {
      this.lastError =
        'The token-store passphrase is not set yet — finish the migration/setup prompt first.'
      this.setState('crashed')
      return
    }

    let secrets: McpSpawnSecrets = { oauthPassphrase: passphrase }
    if (config.provider === 'plaid') {
      const creds = this.deps.loadPlaidCredentials()
      if (!creds) {
        this.lastError = 'Plaid provider selected but credentials are not set yet. Add them in Settings.'
        this.setState('crashed')
        return
      }
      secrets = { ...secrets, plaid: { ...creds, passphrase } }
    } else if (config.provider === 'simplefin') {
      secrets = { ...secrets, simplefin: { passphrase } }
    }

    // Resolve the identity against the policy as it is RIGHT NOW, every
    // spawn — config and policy are both re-read here, so editing either one
    // and hitting Restart is enough to change what the child asserts. An
    // unresolvable identity is surfaced (`agentIdWarning`) rather than
    // treated as a fatal pre-flight failure like the missing-credentials
    // cases above: the child still starts and still serves `tools/list`, and
    // a visible warning on a running server beats no server at all when the
    // fix is a one-line policy edit away.
    const identity = await resolveSupervisedAgentId(config.policy_path, config.agent_id)
    // Standing security checklist: this warning crosses IPC to the renderer
    // and is derived from stored data (the configured policy path, plus the
    // underlying parse error when the policy is unreadable), so it goes
    // through `redactSecrets` like every other error string this manager
    // exposes — same treatment the stderr tail gets in `spawnWithEnv`.
    const { redactSecrets } = await getCladCore()
    this.agentIdWarning = identity.warning ? redactSecrets(identity.warning) : undefined
    this.agentIdWarningIsInformational = identity.warningIsInformational ?? false
    this.runningAgentId = identity.agentId

    await this.spawnWithEnv({ ...config, agent_id: identity.agentId }, secrets, attemptId)
  }

  private async spawnWithEnv(
    config: CladConfig,
    secrets: McpSpawnSecrets | undefined,
    attemptId: number
  ): Promise<void> {
    const serverEntry = resolveMcpServerEntry()
    const port = resolveMcpHttpPort()
    const env = buildServerEnv(config, secrets, { transport: 'http', httpPort: port })

    // Spawn the child ourselves (the HTTP client transport, unlike the old
    // stdio transport, does NOT spawn the process). stdout is ignored — the
    // MCP protocol runs over HTTP now, not stdio — and stderr is piped so we
    // can surface a redacted tail on failure.
    const child = spawn(process.execPath, [serverEntry], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.child = child

    let stderrBuf = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000)
    })
    child.on('exit', () => this.handleUnexpectedClose(attemptId))
    child.on('error', () => this.handleUnexpectedClose(attemptId))

    const url = new URL(mcpLoopbackUrl(port))

    try {
      await this.waitForHttpReadiness(url, () => child.exitCode !== null)

      if (attemptId !== this.currentAttemptId) {
        // A stop()/newer start() superseded this attempt while the readiness
        // probe was in flight. Leave whatever state the superseding call
        // already established alone.
        child.kill()
        return
      }

      this.tools = [...SUPERVISED_CHILD_TOOL_NAMES]
      this.upSince = Date.now()
      this.setState('running')
    } catch (err) {
      if (attemptId !== this.currentAttemptId) return
      if (this.state === 'crashed') return // already handled by a racing child 'exit'

      const { redactSecrets } = await getCladCore()
      this.lastError = redactSecrets(
        `${err instanceof Error ? err.message : String(err)} | stderr: ${stderrBuf.slice(-500)}`
      )
      try {
        child.kill()
      } catch {
        // best-effort
      }
      this.child = null
      this.runningAgentId = null
      this.setState('crashed')
      this.scheduleAutoRestart()
    }
  }

  /**
   * Retries an UNAUTHENTICATED `fetch` against `/mcp` while the freshly-
   * spawned child is still binding its loopback port. See this file's
   * READINESS & CRASH DETECTION doc comment (top of file) for why this is no
   * longer an authenticated MCP `Client` session: ANY HTTP response (401
   * once `CLAD_MCP_AUTH=oauth` is set, which it always is post-Wave-6) means
   * the child is up, bound, and its OAuth resources constructed without
   * throwing — `fetch` itself throwing means the port isn't bound yet.
   * Aborts early if the child exits before it ever listens.
   */
  private async waitForHttpReadiness(url: URL, childHasExited: () => boolean): Promise<void> {
    const deadline = Date.now() + READINESS_TIMEOUT_MS
    let lastErr: unknown
    while (Date.now() < deadline) {
      if (childHasExited()) throw new Error('MCP server process exited before it began listening.')

      try {
        const res = await fetch(url)
        await res.text().catch(() => undefined) // drain the small JSON body; status is irrelevant, see doc comment above
        return
      } catch (err) {
        lastErr = err
        await sleep(READINESS_POLL_INTERVAL_MS)
      }
    }
    throw new Error(
      `Timed out after ${READINESS_TIMEOUT_MS}ms waiting for the MCP server to accept a loopback HTTP connection` +
        (lastErr ? ` (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : '')
    )
  }

  private handleUnexpectedClose(attemptId: number): void {
    if (attemptId !== this.currentAttemptId) return // stale event from a superseded attempt
    if (this.expectedStop) return
    if (this.state === 'crashed' || this.state === 'stopped' || this.state === 'stopping') return

    this.child = null
    this.runningAgentId = null
    this.lastError = this.lastError ?? 'The MCP server process exited unexpectedly.'
    this.setState('crashed')
    this.scheduleAutoRestart()
  }

  private scheduleAutoRestart(): void {
    if (this.upSince && Date.now() - this.upSince > BACKOFF_RESET_AFTER_MS) {
      this.restartAttempt = 0
    }
    this.upSince = null

    if (this.restartAttempt >= MAX_AUTO_RESTART_ATTEMPTS) {
      // Give up auto-restarting; stay 'crashed' until a manual start()/restart().
      return
    }

    const delay = computeBackoffDelayMs(this.restartAttempt)
    this.restartAttempt += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.spawnAndConnect()
    }, delay)
  }

  private async teardown(): Promise<void> {
    try {
      this.child?.kill()
    } catch {
      // best-effort
    }
    this.child = null
    this.tools = []
    this.runningAgentId = null
  }
}
