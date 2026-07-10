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
  /** D3.3: the env-scoped path actually in use for `plaidEnv` below (see `main/lib/config.ts`'s `effectivePlaidDbPath`) — NOT necessarily the raw `plaid_db` field from config.json when `plaidEnv` is `'sandbox'`. */
  plaidDbPath: string
  provider: CladProvider
  /**
   * The EFFECTIVE Plaid environment — already normalized to `'production'`
   * when `isPackaged` is true, regardless of what config.json's `plaid_env`
   * field says (see `main/lib/config.ts`'s `effectivePlaidEnv`). Renderer
   * code should treat this as the source of truth, not re-derive it.
   */
  plaidEnv: PlaidEnvName
  /** Whether Plaid credentials are currently set, unset, or sealed-but-unreadable for the ACTIVE env (`plaidEnv` above) — never their value. */
  plaidCredentialsStatus: PlaidCredentialsStatus
  /** D1.3: whether closing the main window hides it (tray stays alive) instead of quitting. */
  closeToTray: boolean
  /**
   * D3.3: `app.isPackaged`. Drives Settings' Plaid-environment UI — a
   * packaged build shows a static "Production" indication instead of the
   * sandbox/production `<select>`, since packaged builds are production-only
   * and `configSetProviderAndEnv` rejects any attempt to set `'sandbox'`
   * while this is true. Reuses this existing display-config channel rather
   * than adding a new one, per the product decision that introduced env
   * gating.
   */
  isPackaged: boolean
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
  /** The account's financial institution, when the provider can resolve one (SimpleFIN has always populated this; Plaid started populating it too as of the D3 QA amendment, 2026-07-10) — `undefined` for the dummy provider. */
  institution?: string
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

// ---- Policy editor (D2.4) ---------------------------------------------------
//
// Standalone mirror of `PolicyConfig`/`AgentPolicy`/... from `@clad/core`
// (`packages/core/src/types/policy.types.ts`), not an import of it — same
// reasoning as `DashboardAccount`/`DashboardTransaction` above: this file
// must stay importable from the renderer/preload build without pulling in
// `@clad/core` (ESM-only, and irrelevant to the wire contract itself). Keep
// these field-for-field in sync with `policy.types.ts` if that schema ever
// changes; `main/lib/policy-data.ts` relies on the two being structurally
// identical so `parsePolicy`'s real return value satisfies this shape with
// no manual mapping step (unlike the dashboard, which does map).

export interface PolicyAccountPermissions {
  visible: string[]
  balance?: boolean
  account_number?: boolean
  routing_number?: boolean
}

export interface PolicyTransactionPermissions {
  read: boolean
  amount_visibility_cap?: number
  description_visibility?: boolean
  lookback_days?: number
}

export interface PolicyMerchantFilter {
  allow?: string[]
  block?: string[]
}

export interface PolicyCategoryFilter {
  allow?: string[]
  block?: string[]
}

export interface PolicySpendingPermissions {
  max_per_transaction?: number
  max_daily?: number
  max_weekly?: number
  max_monthly?: number
  merchants?: PolicyMerchantFilter
  categories?: PolicyCategoryFilter
  require_itemization?: boolean
}

export type PolicyEscalationTrigger =
  | { amount_exceeds: number }
  | { new_merchant: boolean }
  | { new_category: boolean }
  | { category: string[] }
  | { merchant: string[] }
  | { daily_spend_exceeds_pct: number }

export interface PolicyEscalationConfig {
  triggers: PolicyEscalationTrigger[]
  channel: 'cli' | 'webhook'
  timeout: string
  default_on_timeout: 'deny' | 'allow'
}

export interface PolicyScheduleConfig {
  active_hours?: string
  active_days?: string[]
  timezone?: string
  blackout_dates?: string[]
  behavior_outside_schedule?: 'deny' | 'escalate'
}

export interface PolicyAuditConfig {
  log_all_queries?: boolean
  log_policy_evaluations?: boolean
  retention?: string
}

export interface PolicyAgentPermissions {
  accounts?: PolicyAccountPermissions
  transactions?: PolicyTransactionPermissions
  spending?: PolicySpendingPermissions
  escalation?: PolicyEscalationConfig
  schedule?: PolicyScheduleConfig
  audit?: PolicyAuditConfig
}

export interface PolicyAgent {
  description: string
  permissions: PolicyAgentPermissions
}

export interface PolicyGlobalRules {
  max_total_daily_spend?: number
  max_total_weekly_spend?: number
  max_total_monthly_spend?: number
  max_concurrent_agents?: number
  max_pending_escalations?: number
  global_blocked_categories?: string[]
  global_blocked_merchants?: string[]
}

export interface PolicyDoc {
  agents: Record<string, PolicyAgent>
  global?: PolicyGlobalRules
}

/**
 * `getPolicy()`'s result. `ok: true` includes both the schema-validated
 * `policy` object (what the editor mutates) and the `raw` YAML text as
 * currently on disk (empty string if the policy file doesn't exist yet).
 * `ok: false` means the file on disk right now fails to parse/validate —
 * still surfaced (not thrown) so the editor can show the error and let the
 * user start fresh rather than being stuck on a blank screen.
 */
export type PolicyGetResult =
  | { ok: true; policy: PolicyDoc; raw: string }
  | { ok: false; error: string }

// ---- Approvals inbox (D2.1) -------------------------------------------------

/** Standalone copy of `@clad/core`'s `ApprovalStatus` union — same layering rule as `McpServerState` above (this file must stay importable from the renderer/preload build, so it never imports from `@clad/core` or `src/main/**`). */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

/** Display-safe view of an `@clad/core` `ApprovalRecord` — camelCased field names, otherwise a 1:1 copy (every field here was already non-secret). */
export interface ApprovalListItem {
  id: string
  agentId: string
  toolName: string
  triggerReason: string
  status: ApprovalStatus
  createdAt: string
  expiresAt: string
  resolvedAt?: string
}

/** Omit `status` (or pass `'pending'`) for the inbox's default pending-only view; `'all'` includes resolved/expired history too. */
export interface ApprovalsListInput {
  status?: ApprovalStatus | 'all'
}

export interface ApprovalDecisionInput {
  id: string
  decision: 'approve' | 'deny'
}

export interface ApprovalDecisionResult {
  ok: boolean
  /** Display-safe (redacted where derived from stored/thrown data). Never secret material. */
  error?: string
  record?: ApprovalListItem
}

/** Pushed main -> renderer when the user clicks the native OS notification for a newly-appeared pending approval — see `onApprovalFocusRequested` below. */
export interface ApprovalFocusRequest {
  id: string
}

// ---- Connect flow (D3.1 Plaid Link, D3.2 provider-agnostic connect UI) ----

/**
 * `'idle'` — no flow in progress (nothing started yet, or the last one
 * finished/was cancelled and the user has moved on). `'pending'` — the
 * loopback server is up and the system browser has been opened; waiting on
 * the user to finish (or cancel) Plaid Link in their browser — this can take
 * minutes. `'success'` / `'error'` are terminal until the next `startPlaidLink`
 * or `cancelPlaidLink` call.
 */
export type PlaidLinkFlowState = 'idle' | 'pending' | 'success' | 'error'

/** Display-safe summary of one linked account — never a token. */
export interface PlaidLinkedAccountSummary {
  id: string
  name: string
  mask?: string
}

export interface PlaidLinkFlowStatus {
  state: PlaidLinkFlowState
  institutionName?: string
  itemId?: string
  accounts?: PlaidLinkedAccountSummary[]
  /** Display-safe (redacted where derived from a thrown Plaid/link error). */
  error?: string
}

export interface StartPlaidLinkInput {
  /** Dev-flag-gated sandbox auto-connect (no browser) — see `main/lib/plaid-link-flow.ts`'s `isDevBuild` gate and `connect.ts`'s `--sandbox-auto`. Ignored (and rejected with a clear error) outside a development build or outside `plaidEnv: 'sandbox'`. */
  sandboxAuto?: boolean
}

/** Display-safe summary of a claimed SimpleFIN account — never the access URL or a raw un-namespaced account id. */
export interface SimpleFinAccountSummary {
  id: string
  name: string
  institution?: string
}

export interface SimpleFinConnectResult {
  ok: boolean
  itemId?: string
  accounts?: SimpleFinAccountSummary[]
  /** Set alongside `ok: true` when the item was saved but the initial account-summary fetch failed — non-fatal (the credential is never lost just because this follow-up fetch failed). */
  warning?: string
  /** Display-safe (redacted where derived from stored/thrown data). Set when `ok: false`. */
  error?: string
}

/**
 * `'unavailable'` when the token-store passphrase isn't resolved yet.
 * Distinct from `'not-connected'` (passphrase resolved, but nothing saved
 * yet for that provider).
 */
export type ProviderConnectionState = 'connected' | 'not-connected' | 'unavailable'

/** Everything the D3.2 "Add connection" screen needs to render its provider list — no secret material, just presence/connection state. */
export interface ConnectProvidersStatus {
  /** Reuses the existing D1.1 `plaidCredentialsHas`-shaped check. */
  plaidCredentialsConfigured: boolean
  plaidConnection: ProviderConnectionState
  simplefinConnection: ProviderConnectionState
  /** Whether the sandbox-auto (no-browser) Plaid dev flag should be shown at all in this build — see `plaid-link-flow.ts`'s `isDevBuild`. */
  sandboxAutoAvailable: boolean
  /** D3.3: the EFFECTIVE Plaid environment a new "Connect a bank" flow will link into — same normalized value as `DisplayConfig.plaidEnv` (already `'production'` in a packaged build regardless of config.json). */
  plaidEnv: PlaidEnvName
}

// ---- Audit log viewer (D2.2) ------------------------------------------------

/** Display-safe view of an `@clad/core` `AuditRecord` — camelCased field names, otherwise a 1:1 copy (every field here was already non-secret; the hash-chain fields are intentionally omitted as not useful for this read-only viewer). */
export interface AuditLogRow {
  id: string
  timestamp: string
  agentId: string
  eventType: string
  toolName?: string
  decision?: string
  reason?: string
}

export interface AuditLogFilter {
  agentId?: string
  toolName?: string
  decision?: string
  /** ISO 8601 date or date-time, inclusive lower bound on `timestamp`. */
  startDate?: string
  /** ISO 8601 date or date-time, inclusive upper bound on `timestamp`. */
  endDate?: string
}

export interface AuditLogQueryInput {
  filter?: AuditLogFilter
  /** 1-indexed. */
  page: number
  pageSize: number
}

/** Rows are newest-first. Only one page ever crosses IPC — the full filtered result set stays in the main process (see `main/lib/audit-log.ts`). */
export interface AuditLogPage {
  rows: AuditLogRow[]
  total: number
  page: number
  pageSize: number
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
  // D2.4
  policyGet: 'policy:get',
  policySet: 'policy:set',
  approvalsList: 'approvals:list',
  approvalsDecide: 'approvals:decide',
  /** Push-only, main -> renderer. See `onApprovalFocusRequested` below. */
  approvalFocusRequested: 'approvals:focusRequested',
  auditLogQuery: 'auditLog:query',
  // D3.1 / D3.2
  connectGetProvidersStatus: 'connect:getProvidersStatus',
  plaidLinkStart: 'connect:plaidLinkStart',
  plaidLinkCancel: 'connect:plaidLinkCancel',
  plaidLinkGetStatus: 'connect:plaidLinkGetStatus',
  /** Push-only, main -> renderer. See `onPlaidLinkStatusChanged` below. */
  plaidLinkStatusChanged: 'connect:plaidLinkStatusChanged',
  simplefinConnect: 'connect:simplefinConnect',
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
  /** Reads the policy file fresh from disk every call — no cache, no rate-limit concern (this is a local file, not a third-party API). */
  getPolicy(): Promise<PolicyGetResult>
  /** Validates against `@clad/core`'s policy schema in the main process before writing; never trusts the renderer's shape. See `main/lib/policy-data.ts`. */
  setPolicy(policy: PolicyDoc): Promise<OperationResult>
  /** Omit `input` (or `status: 'pending'`) for pending-only; `status: 'all'` includes resolved/expired history. Rejects on a genuine read failure (surfaced by the inbox as an error state) — unlike the tray's best-effort count, this is a user-watched list. */
  listApprovals(input?: ApprovalsListInput): Promise<ApprovalListItem[]>
  /** Approves or denies a pending approval — writes through the real `@clad/core` `ApprovalQueue` and audit-logs the decision, same as the CLI's `clad approve`/`clad deny` (see `main/lib/approvals.ts`). Never throws; failures come back as `{ ok: false, error }`. */
  decideApproval(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult>
  /**
   * Fires when the user clicks the native OS notification shown for a
   * newly-appeared pending approval — main process already focused the
   * window by the time this arrives; the payload is which item to
   * scroll-to/highlight in the inbox.
   */
  onApprovalFocusRequested(callback: (request: ApprovalFocusRequest) => void): () => void
  /** Read-only, paginated, newest-first. Rejects on a genuine read failure (surfaced by the viewer as an error state). */
  queryAuditLog(input: AuditLogQueryInput): Promise<AuditLogPage>
  /** Provider list + connection state for the D3.2 "Add connection" screen. */
  getConnectProvidersStatus(): Promise<ConnectProvidersStatus>
  /** Kicks off (or returns the already-`'pending'` status of) the D3.1 in-app Plaid Link flow. Resolves once the flow settles OR immediately with an `'error'` status for a synchronous pre-flight failure (e.g. missing credentials) — the renderer should still subscribe to `onPlaidLinkStatusChanged` for the common case where this takes a while. */
  startPlaidLink(input?: StartPlaidLinkInput): Promise<PlaidLinkFlowStatus>
  /** Stops watching the current flow (if any) and clears a terminal success/error status back to idle. See `plaid-link-flow.ts`'s module doc for what this does/doesn't tear down. */
  cancelPlaidLink(): Promise<PlaidLinkFlowStatus>
  getPlaidLinkStatus(): Promise<PlaidLinkFlowStatus>
  /** Subscribes to live progress pushes for the Plaid Link flow. Returns an unsubscribe function — same shape as `onMcpStatusChanged`. */
  onPlaidLinkStatusChanged(callback: (status: PlaidLinkFlowStatus) => void): () => void
  /** Claims a pasted SimpleFIN setup token and stores the resulting access URL — see `simplefin-connect.ts`. The setup token is renderer -> main only; the resulting access URL is never returned. */
  connectSimpleFin(setupToken: string): Promise<SimpleFinConnectResult>
}

/** `start`/`stop`/`restartMcpServer` resolve once the *attempt* finishes, not necessarily to `'running'` (e.g. a crash pre-flight check fails synchronously) — callers read `.state`/`.lastError` same as any push update. */
export type McpProcessResult = McpServerStatus
