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
 * every field below is display-safe. No Plaid access token, no token-store
 * passphrase, no Plaid Client ID/Secret ever crosses this boundary in the
 * main → renderer direction. The renderer → main direction does carry
 * user-typed secrets for a few write-only actions (entering a Plaid secret,
 * submitting a CLI passphrase during migration) — those are one-way inputs
 * that get sealed via `safeStorage` in the main process and are never echoed
 * back; see `plaid-secrets.ts` / `passphrase.ts`.
 *
 * This file grows with each D1 sub-task (D1.1 config/migration/Plaid
 * credentials below; D1.2 adds MCP lifecycle; D1.3 adds the `closeToTray`
 * setting; D1.4 adds Claude Desktop connect) — extended in place, never
 * bypassed.
 *
 * Note on layering: this file must stay importable from the renderer/
 * preload build (`tsconfig.web.json`'s `include` is renderer + shared only —
 * it does not include `src/main/**`), so it never imports from `src/main/**`
 * even for types. `McpServerState` below is intentionally a standalone copy
 * of the same union in `src/main/lib/mcp-server-manager.ts` rather than an
 * import of it.
 */

// ---- Config (D1.1) --------------------------------------------------------

export type CladProvider = 'dummy' | 'plaid'
export type PlaidEnvName = 'sandbox' | 'production'

/**
 * `'unset'` — nothing saved yet. `'set'` — saved and currently readable.
 * `'undecryptable'` — a sealed file exists but can't be unlocked right now
 * (D1 manual QA finding 3 — see `plaid-secrets.ts`'s module doc: typically a
 * packaged, differently code-signed build unable to open ciphertext a dev
 * build wrote). Never implies the credential values themselves cross IPC —
 * only this three-way state does.
 */
export type PlaidCredentialsStatus = 'unset' | 'set' | 'undecryptable'

/** Display-safe view of `~/.clad/config.json` — paths and non-secret settings only. */
export interface DisplayConfig {
  configDir: string
  policyPath: string
  auditDbPath: string
  approvalDbPath: string
  plaidDbPath: string
  provider: CladProvider
  plaidEnv: PlaidEnvName
  /** Whether Plaid credentials are currently set, unset, or sealed-but-unreadable — never their value. */
  plaidCredentialsStatus: PlaidCredentialsStatus
  /** D1.3: whether closing the main window hides it (tray stays alive) instead of quitting. */
  closeToTray: boolean
}

export interface SetProviderAndEnvInput {
  provider: CladProvider
  plaidEnv: PlaidEnvName
}

export interface SetCloseToTrayInput {
  closeToTray: boolean
}

export interface SetPlaidCredentialsInput {
  clientId: string
  secret: string
}

export interface OperationResult {
  ok: boolean
  /** Display-safe (redacted where derived from stored/thrown data). Never secret material. */
  error?: string
}

// ---- Migration (D1.1) ------------------------------------------------------

/**
 * `'cli-store-detected'` — a pre-existing CLI-managed token store was found
 * with no desktop passphrase custody resolved yet (the original migration
 * case — see "Spike results" S0.3 in packages/docs/plans/desktop-app.md).
 * `'passphrase-undecryptable'` — a desktop-managed passphrase WAS sealed,
 * but this OS keychain can no longer open it (D1 manual QA finding 3 — see
 * `passphrase.ts`'s `PassphraseSource` doc). Both route to the same
 * `MigrationPrompt` UI (enter a known passphrase, or start fresh) since the
 * mechanics are identical; only the explanatory copy differs.
 */
export type MigrationReason = 'cli-store-detected' | 'passphrase-undecryptable'

/** Whether the one-time migration/recovery prompt needs to show, and why. */
export interface MigrationStatus {
  needed: boolean
  reason?: MigrationReason
  plaidDbPath: string
}

// ---- MCP server lifecycle (D1.2) ------------------------------------------

export type McpServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

/**
 * IPC-facing server status: the `McpServerManager`'s own process-lifecycle
 * status (see `McpProcessStatus` in `main/lib/mcp-server-manager.ts`) merged
 * with a live pending-approvals count. Pushed to the renderer on every
 * change via the `mcpStatusChanged` event, and returned directly by
 * `getMcpStatus`/`startMcpServer`/`stopMcpServer`/`restartMcpServer`.
 */
export interface McpServerStatus {
  state: McpServerState
  pid?: number
  tools: string[]
  /** Display-safe (redacted where derived from child stderr). Never secret material. */
  lastError?: string
  restartAttempt: number
  pendingApprovals: number
}

// ---- Claude Desktop connect (D1.4) -----------------------------------------

/**
 * Preview shown to the user BEFORE writing anything to Claude Desktop's own
 * config file (desktop-app.md D1.4: "Show a diff/confirmation ... before
 * writing another app's config file"). Both JSON blobs are display-safe by
 * construction — the `clad` MCP server entry they describe never carries
 * Plaid secrets or the token-store passphrase, even if this app's own
 * provider is configured to `plaid`; see `main/lib/claude-desktop-config.ts`'s
 * module doc for why that's a deliberate, security-motivated choice and not
 * a gap.
 */
export interface ClaudeDesktopConnectPreview {
  /** Whether Claude Desktop looks installed on this machine (its app-support directory exists). */
  installed: boolean
  /** Where its config file lives (or would live) on this platform. */
  configPath: string
  /** Pretty-printed JSON of the config file as it exists today, or `null` if it doesn't exist yet (but Claude Desktop is installed). */
  currentConfigJson: string | null
  /** Pretty-printed JSON of the config after non-destructively merging in the `clad` MCP server entry, using `resolvedAgentId` for `CLAD_AGENT_ID`. */
  proposedConfigJson: string
  /** True when `mcpServers.clad` already matches the proposed entry exactly — connecting again would be a no-op. */
  alreadyConnected: boolean
  /**
   * Every agent ID found in the policy at the path this entry will point at
   * (empty when the policy is missing/empty/invalid — see
   * `agentFallbackReason` below). Length > 1 means the confirmation dialog
   * should show a selector rather than silently picking one (D1 manual QA
   * finding 2).
   */
  availableAgentIds: string[]
  /** The agent ID `proposedConfigJson`'s `CLAD_AGENT_ID` was built with — pass this (or a different pick from `availableAgentIds`) back to `getClaudeDesktopConnectPreview`/`connectClaudeDesktop` to keep the two in sync. */
  resolvedAgentId: string
  /** Set (and shown to the user) only when `resolvedAgentId` fell back to `'default-agent'` because the policy couldn't supply a real one. */
  agentFallbackReason?: string
}

// ---- Dashboard (D2.3) -------------------------------------------------------

/**
 * `'no-provider-configured'` — the `plaid` provider is selected but Plaid
 * credentials and/or the token-store passphrase aren't fully resolved yet
 * (`'dummy'` is always "configured" — zero setup, see `main/lib/provider-
 * factory.ts`). `'ready'` — the last fetch (or the absence of one) is
 * otherwise normal. `'error'` — the last `refreshDashboard()` attempt
 * failed; `accounts`/`transactions` still reflect the last successful
 * fetch, if any (shown honestly stale rather than hidden — desktop-app.md
 * D2.3's framing: "Stale data shown honestly beats fresh data that burns
 * quota").
 */
export type DashboardProviderState = 'no-provider-configured' | 'ready' | 'error'

/** Display-safe account view. Never an account/routing number — the underlying `FinancialDataProvider` account shape doesn't carry those at all, regardless of policy. */
export interface DashboardAccount {
  id: string
  name: string
  type: 'checking' | 'savings' | 'credit' | 'loan' | 'investment'
  /** Last few digits only, when the provider supplies one (e.g. Plaid's account mask). */
  mask?: string
  balanceCurrent: number
  balanceAvailable?: number
  currency: string
  /** True when this reflects a degraded/cached read rather than a live one. */
  stale?: boolean
}

export interface DashboardTransaction {
  id: string
  accountId: string
  amount: number
  date: string
  description: string
  merchantName?: string
  category?: string[]
  pending: boolean
  stale?: boolean
}

/**
 * The dashboard's entire renderer-facing state. `lastRefreshed` is the ISO
 * timestamp of the last successful `refreshDashboard()` call THIS SESSION —
 * `null` means nothing has been fetched since the app launched (in-memory
 * cache only, by design; see `main/lib/dashboard-data.ts`'s module doc).
 * `getDashboardSnapshot` NEVER triggers a fetch; only `refreshDashboard`
 * does (rate-limit discipline, desktop-app.md D2.3 — never poll on an
 * interval).
 */
export interface DashboardSnapshot {
  state: DashboardProviderState
  provider: CladProvider
  accounts: DashboardAccount[]
  transactions: DashboardTransaction[]
  lastRefreshed: string | null
  /** Display-safe (redacted where derived from a thrown provider error). */
  error?: string
}

// ---- IPC channel names ----------------------------------------------------

export const IPC_CHANNELS = {
  configGet: 'config:get',
  configSetProviderAndEnv: 'config:setProviderAndEnv',
  configSetCloseToTray: 'config:setCloseToTray',
  plaidCredentialsHas: 'plaid:credentialsHas',
  plaidCredentialsSet: 'plaid:credentialsSet',
  plaidCredentialsClear: 'plaid:credentialsClear',
  migrationGetStatus: 'migration:getStatus',
  migrationSubmitCliPassphrase: 'migration:submitCliPassphrase',
  migrationStartFresh: 'migration:startFresh',
  mcpGetStatus: 'mcp:getStatus',
  mcpStart: 'mcp:start',
  mcpStop: 'mcp:stop',
  mcpRestart: 'mcp:restart',
  /** Push-only, main -> renderer. See `onMcpStatusChanged` below. */
  mcpStatusChanged: 'mcp:statusChanged',
  claudeDesktopGetPreview: 'claudeDesktop:getPreview',
  claudeDesktopConnect: 'claudeDesktop:connect',
  // D2.3
  dashboardGetSnapshot: 'dashboard:getSnapshot',
  dashboardRefresh: 'dashboard:refresh',
} as const

/** The shape exposed on `window.clad` by the preload script. */
export interface CladBridge {
  getConfig(): Promise<DisplayConfig>
  setProviderAndEnv(input: SetProviderAndEnvInput): Promise<OperationResult>
  setCloseToTray(input: SetCloseToTrayInput): Promise<OperationResult>
  hasPlaidCredentials(): Promise<boolean>
  setPlaidCredentials(input: SetPlaidCredentialsInput): Promise<OperationResult>
  clearPlaidCredentials(): Promise<OperationResult>
  getMigrationStatus(): Promise<MigrationStatus>
  submitCliPassphrase(passphrase: string): Promise<OperationResult>
  startFreshTokenStore(): Promise<OperationResult>
  getMcpStatus(): Promise<McpServerStatus>
  startMcpServer(): Promise<McpProcessResult>
  stopMcpServer(): Promise<McpProcessResult>
  restartMcpServer(): Promise<McpProcessResult>
  /**
   * Subscribes to live status pushes. Returns an unsubscribe function.
   * The only place a raw `ipcRenderer.on` appears is inside the preload
   * script's implementation of this — renderer code never touches
   * `ipcRenderer` directly (security checklist: no arbitrary channel access).
   */
  onMcpStatusChanged(callback: (status: McpServerStatus) => void): () => void
  /** `agentId` re-resolves the preview against a specific (e.g. user-picked) agent id instead of the default; omit to get the default resolution. */
  getClaudeDesktopConnectPreview(agentId?: string): Promise<ClaudeDesktopConnectPreview>
  /** `agentId` should be whatever the last preview resolved to (`resolvedAgentId`, or the user's picked one) — see `ClaudeDesktopConnectPreview`'s doc comment. */
  connectClaudeDesktop(agentId?: string): Promise<OperationResult>
  /** Pure cache read — never triggers a fetch. See `DashboardSnapshot`'s doc comment. */
  getDashboardSnapshot(): Promise<DashboardSnapshot>
  /** The only call that ever triggers a live provider fetch — wire this to an explicit user action only, never a timer. */
  refreshDashboard(): Promise<DashboardSnapshot>
}

/** `start`/`stop`/`restartMcpServer` resolve once the *attempt* finishes, not necessarily to `'running'` (e.g. a crash pre-flight check fails synchronously) — callers read `.state`/`.lastError` same as any push update. */
export type McpProcessResult = McpServerStatus
