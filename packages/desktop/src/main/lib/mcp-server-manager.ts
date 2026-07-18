/**
 * Productionizes the S0.4 spike (`src/main/spike/mcp-handshake.ts`, now
 * removed) into a real start/stop/restart lifecycle with crash detection
 * and capped backoff, per D1.2.
 *
 * D5.3 WS1 (interim "3 dummy accounts" fix): the supervised child now runs in
 * loopback **HTTP** mode (`CLAD_MCP_TRANSPORT=http`), not stdio. The manager
 * therefore spawns the child process itself (`child_process.spawn`) with the
 * passphrase/provider env already injected (`buildServerEnv` with the
 * `http` transport option), then connects a persistent `@modelcontextprotocol/
 * sdk` `Client` over `StreamableHTTPClientTransport` to
 * `http://127.0.0.1:<port>/mcp` as the readiness gate and liveness signal.
 *
 * Why HTTP: unlike a `StdioServerTransport` (which can only usefully serve one
 * client for its process lifetime — closing the verifying client's transport
 * terminates the child), an HTTP server serves many clients concurrently. So
 * the manager's own readiness `Client` AND Claude Desktop's `mcp-remote`
 * client can both be connected to the same already-unlocked child at once —
 * which is the whole point of the fix (real provider data reaches Claude
 * Desktop with zero secrets in any config file; see `claude-desktop-config.ts`
 * and `@clad/mcp-server`'s `http-transport.ts`).
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
 * Crash detection: driven off the child process's `exit`/`error` events
 * (direct and reliable), with the HTTP transport's `onclose` as a secondary
 * signal. Readiness: a real `tools/list` round trip over HTTP, retried until
 * the child has bound its port or a timeout elapses.
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { resolveMcpServerEntry } from './mcp-server-path.js'
import { buildServerEnv, type McpSpawnSecrets } from './mcp-server-env.js'
import { resolveMcpHttpPort, mcpLoopbackUrl } from './mcp-loopback.js'
import { resolveSupervisedAgentId } from './agent-resolution.js'
import { getCladCore } from './clad-core.js'
import type { CladConfig } from './config.js'

export type McpServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

/** Manager-internal status — process lifecycle only. `index.ts` merges this with a live pending-approvals count before it crosses IPC (see `McpServerStatus` in `shared/ipc.ts`). */
export interface McpProcessStatus {
  state: McpServerState
  pid?: number
  tools: string[]
  lastError?: string
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
  private client: Client | null = null
  private transport: StreamableHTTPClientTransport | null = null
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
   * Non-fatal agent-identity problem from the last spawn (see
   * `SupervisedAgentResolution.warning`). Kept separate from `lastError` so a
   * real failure always wins the single `lastError` slot — `getStatus` falls
   * back to this only when there's no actual error, which is precisely the
   * dangerous case: a child that looks healthy but denies every tool call.
   */
  private agentIdWarning: string | undefined

  constructor(private readonly deps: McpServerManagerDeps) {}

  getStatus(): McpProcessStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? undefined,
      tools: this.tools,
      lastError: this.lastError ?? this.agentIdWarning,
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
    // Cleared up front so an early return below (missing credentials) can
    // never leave a previous run's identity looking current.
    this.runningAgentId = null
    this.currentAttemptId += 1
    const attemptId = this.currentAttemptId
    this.setState('starting')

    const config = this.deps.loadConfig()

    let secrets: McpSpawnSecrets | undefined
    if (config.provider === 'plaid') {
      const creds = this.deps.loadPlaidCredentials()
      const passphrase = this.deps.getActivePassphrase()
      if (!creds || !passphrase) {
        this.lastError =
          'Plaid provider selected but credentials or the token-store passphrase are not set yet. Add them in Settings.'
        this.setState('crashed')
        return
      }
      secrets = { plaid: { ...creds, passphrase } }
    } else if (config.provider === 'simplefin') {
      const passphrase = this.deps.getActivePassphrase()
      if (!passphrase) {
        this.lastError =
          'SimpleFIN provider selected but the token-store passphrase is not set yet. Finish the migration/setup prompt first.'
        this.setState('crashed')
        return
      }
      secrets = { simplefin: { passphrase } }
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
      const { client, transport } = await this.connectWithReadinessRetry(url, () => child.exitCode !== null)
      const { tools } = await client.listTools()

      if (attemptId !== this.currentAttemptId) {
        // A stop()/newer start() superseded this attempt while connect()
        // was in flight. Tear down what we just connected and leave
        // whatever state the superseding call already established alone.
        await client.close().catch(() => undefined)
        await transport.close().catch(() => undefined)
        child.kill()
        return
      }

      // Secondary crash signal: if the HTTP session drops (e.g. the child dies
      // and the SSE stream closes) treat it like an unexpected exit. The
      // child 'exit' handler above is the primary signal; the attemptId +
      // state guards in handleUnexpectedClose make a double-fire harmless.
      transport.onclose = () => this.handleUnexpectedClose(attemptId)
      transport.onerror = () => undefined // swallow transient SSE errors; crash detection is exit-driven

      this.client = client
      this.transport = transport
      this.tools = tools.map((t) => t.name)
      this.upSince = Date.now()
      this.setState('running')
    } catch (err) {
      if (attemptId !== this.currentAttemptId) return
      if (this.state === 'crashed') return // already handled by a racing child 'exit'

      const { redactSecrets } = await getCladCore()
      this.lastError = redactSecrets(
        `${err instanceof Error ? err.message : String(err)} | stderr: ${stderrBuf.slice(-500)}`
      )
      this.client = null
      this.transport = null
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
   * Retries the HTTP readiness connection while the freshly-spawned child is
   * still binding its loopback port. A fresh `Client`/transport pair is used
   * per attempt (a transport that failed to connect isn't reusable). Aborts
   * early if the child exits before it ever listens.
   */
  private async connectWithReadinessRetry(
    url: URL,
    childHasExited: () => boolean
  ): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const deadline = Date.now() + READINESS_TIMEOUT_MS
    let lastErr: unknown
    while (Date.now() < deadline) {
      if (childHasExited()) throw new Error('MCP server process exited before it began listening.')

      const transport = new StreamableHTTPClientTransport(url)
      const client = new Client({ name: 'clad-desktop', version: '0.1.0' }, { capabilities: {} })
      try {
        await client.connect(transport)
        return { client, transport }
      } catch (err) {
        lastErr = err
        await client.close().catch(() => undefined)
        await transport.close().catch(() => undefined)
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

    this.client = null
    this.transport = null
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
      await this.client?.close()
    } catch {
      // best-effort
    }
    try {
      await this.transport?.close()
    } catch {
      // best-effort
    }
    try {
      this.child?.kill()
    } catch {
      // best-effort
    }
    this.client = null
    this.transport = null
    this.child = null
    this.tools = []
    this.runningAgentId = null
  }
}
