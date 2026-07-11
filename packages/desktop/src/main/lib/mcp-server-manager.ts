/**
 * Productionizes the S0.4 spike (`src/main/spike/mcp-handshake.ts`, now
 * removed) into a real start/stop/restart lifecycle with crash detection
 * and capped backoff, per D1.2.
 *
 * Keeps the spike's core technique — a persistent `@modelcontextprotocol/
 * sdk` `Client` over `StdioClientTransport`, not a bare `child_process.
 * spawn()` — because a `StdioServerTransport`-based server can only usefully
 * serve one client for its process lifetime (closing the verifying
 * client's transport terminates the child; see the spike's
 * `stopMcpHandshakeSpike`). So the manager holds the client connection open
 * for as long as the server is meant to be "running": it doubles as the
 * readiness gate (a real `tools/list` round trip, not just "the process
 * didn't immediately exit") and as the liveness signal that drives crash
 * detection via the transport's `onclose`/`onerror` hooks.
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolveMcpServerEntry } from './mcp-server-path.js'
import { buildServerEnv, type McpSpawnSecrets } from './mcp-server-env.js'
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

export class McpServerManager {
  private state: McpServerState = 'stopped'
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private tools: string[] = []
  private lastError: string | undefined
  private restartAttempt = 0
  private expectedStop = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private upSince: number | null = null
  /** Bumped on every start()/stop(); lets a superseded in-flight spawn attempt detect it should discard its result instead of clobbering newer state. */
  private currentAttemptId = 0

  constructor(private readonly deps: McpServerManagerDeps) {}

  getStatus(): McpProcessStatus {
    return {
      state: this.state,
      pid: this.transport?.pid ?? undefined,
      tools: this.tools,
      lastError: this.lastError,
      restartAttempt: this.restartAttempt,
    }
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

    await this.spawnWithEnv(config, secrets, attemptId)
  }

  private async spawnWithEnv(
    config: CladConfig,
    secrets: McpSpawnSecrets | undefined,
    attemptId: number
  ): Promise<void> {
    const serverEntry = resolveMcpServerEntry()
    const env = buildServerEnv(config, secrets)

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env,
      stderr: 'pipe',
    })

    let stderrBuf = ''
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000)
    })

    // Must be set before client.connect() — Protocol.connect() chains
    // whatever onclose/onerror were already present on the transport rather
    // than clobbering them (verified against the installed SDK's
    // shared/protocol.js), so this is the supported hook point.
    transport.onclose = () => this.handleUnexpectedClose(attemptId)

    const client = new Client({ name: 'clad-desktop', version: '0.1.0' }, { capabilities: {} })

    try {
      await client.connect(transport)
      const { tools } = await client.listTools()

      if (attemptId !== this.currentAttemptId) {
        // A stop()/newer start() superseded this attempt while connect()
        // was in flight. Tear down what we just connected and leave
        // whatever state the superseding call already established alone.
        await client.close().catch(() => undefined)
        await transport.close().catch(() => undefined)
        return
      }

      this.client = client
      this.transport = transport
      this.tools = tools.map((t) => t.name)
      this.upSince = Date.now()
      this.setState('running')
    } catch (err) {
      if (attemptId !== this.currentAttemptId) return
      if (this.state === 'crashed') return // already handled by a racing transport.onclose

      const { redactSecrets } = await getCladCore()
      this.lastError = redactSecrets(
        `${err instanceof Error ? err.message : String(err)} | stderr: ${stderrBuf.slice(-500)}`
      )
      this.client = null
      this.transport = null
      this.setState('crashed')
      this.scheduleAutoRestart()
    }
  }

  private handleUnexpectedClose(attemptId: number): void {
    if (attemptId !== this.currentAttemptId) return // stale event from a superseded attempt
    if (this.expectedStop) return
    if (this.state === 'crashed' || this.state === 'stopped' || this.state === 'stopping') return

    this.client = null
    this.transport = null
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
    this.client = null
    this.transport = null
    this.tools = []
  }
}
