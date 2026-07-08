/**
 * Typed IPC contract between the renderer and the main process.
 *
 * This is the ONLY channel surface the preload script exposes via
 * `contextBridge` (see `src/preload/index.ts`). Renderer code must never
 * call `ipcRenderer.send`/`invoke` directly with an arbitrary channel
 * string — it always goes through `window.clad`, whose shape is defined
 * here, so the whole contract is greppable from one file.
 *
 * Security invariant (roadmap P2/P4, desktop-app.md security checklist):
 * every field below is display-safe. No access token, no token-store
 * passphrase, no Plaid client secret ever crosses this boundary — spike
 * results expose only booleans, counts, version strings, and non-secret
 * paths/metadata.
 */

export const IPC_CHANNELS = {
  getSpikeStatus: 'spike:getStatus',
} as const

/** S0.2 — `node:sqlite` (or fallback) round trip through `SqliteTokenStore`. */
export interface NodeSqliteSpikeResult {
  ok: boolean
  /** Which backend actually serviced the round trip. */
  backend: 'node:sqlite' | 'better-sqlite3' | 'none'
  /** `process.versions.electron` in this process. */
  electronVersion: string
  /** `process.versions.node` — the Node runtime bundled inside this Electron build. */
  bundledNodeVersion: string
  /** Non-secret, redacted error text if `ok === false`. */
  error?: string
}

/** S0.3 — `safeStorage`-backed passphrase custody across relaunch. */
export interface PassphraseCustodySpikeResult {
  ok: boolean
  /** `safeStorage.isEncryptionAvailable()`. */
  encryptionAvailable: boolean
  /** 'generated' on first launch, 'loaded' on every subsequent one. */
  source: 'generated' | 'loaded' | 'unavailable'
  /** Where the encrypted passphrase lives — path only, never its contents. */
  passphraseFilePath: string
  error?: string
}

/** S0.4 — real MCP handshake against a spawned `mcp-server` child process. */
export interface McpHandshakeSpikeResult {
  ok: boolean
  /** Tool names returned by `tools/list`. */
  tools: string[]
  /** The read-only tool that was called as a smoke test. */
  calledTool?: string
  /** First line of the called tool's text result (non-secret dummy data). */
  calledToolResultPreview?: string
  /** PID of the spawned server child (informational only, for orphan checks via `ps`). */
  pid?: number
  error?: string
}

export interface SpikeStatus {
  s02NodeSqlite: NodeSqliteSpikeResult
  s03PassphraseCustody: PassphraseCustodySpikeResult
  s04McpHandshake: McpHandshakeSpikeResult
}

/** The shape exposed on `window.clad` by the preload script. */
export interface CladBridge {
  getSpikeStatus(): Promise<SpikeStatus>
}
