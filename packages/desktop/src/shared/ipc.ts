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

export type CladProvider = 'dummy' | 'plaid' | 'simplefin'
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
  /**
   * Display-safe, non-alarming counterpart to `lastError` (see
   * `McpProcessStatus.agentNotice` in `main/lib/mcp-server-manager.ts`) —
   * currently only "no MCP agent configured, defaulted to one of several"
   * (`agent-resolution.ts`'s `warningIsInformational` case). A healthy,
   * running server can have this set; it does not mean anything is wrong.
   */
  agentNotice?: string
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
  /** Pretty-printed JSON of the config after non-destructively merging in the `clad` MCP server entry. Does NOT vary with `resolvedAgentId` — the entry is a bare `mcp-remote` proxy and the agent identity lives on this app's supervised MCP child instead (see `main/lib/claude-desktop-config.ts`). */
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
  /**
   * The agent identity connecting would put into force: persisted to
   * `config.agent_id` and asserted by this app's supervised MCP child, which
   * is what serves Claude Desktop's tool calls. Defaults to the currently
   * configured identity, falling back to the policy's deterministic first
   * agent. Pass this (or a different pick from `availableAgentIds`) back to
   * `getClaudeDesktopConnectPreview`/`connectClaudeDesktop` to keep the
   * preview and the write in sync.
   */
  resolvedAgentId: string
  /** Set (and shown to the user) only when `resolvedAgentId` fell back to `'default-agent'` because the policy couldn't supply a real one. */
  agentFallbackReason?: string
}

// ---- Dashboard (D2.3) -------------------------------------------------------

/**
 * `'no-provider-configured'` — the `plaid` or `simplefin` provider is
 * selected but its prereqs (Plaid credentials + passphrase, or just the
 * passphrase for SimpleFIN) aren't fully resolved yet (`'dummy'` is always
 * "configured" — zero setup, see `main/lib/provider-factory.ts`). `'ready'`
 * — the last fetch (or the absence of one) is otherwise normal. `'error'` —
 * the last `refreshDashboard()` attempt failed; `accounts`/`transactions`
 * still reflect the last successful fetch, if any (shown honestly stale
 * rather than hidden — desktop-app.md D2.3's framing: "Stale data shown
 * honestly beats fresh data that burns quota").
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
  /** Gates the masked last-4 account number (`mask`) in MCP responses. Default HIDDEN — shown only when explicitly `true`. */
  account_number?: boolean
  /** Default VISIBLE — hidden only when explicitly `false`. */
  name?: boolean
  /** Default VISIBLE — hidden only when explicitly `false`. */
  institution?: boolean
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

/**
 * `setPolicy()`'s result (CLAD-5). `ok: false` means the write itself never
 * happened (invalid policy or a genuine fs error) — same as
 * `main/lib/policy-data.ts`'s own `PolicyWriteResult`, which this wraps.
 *
 * `ok: true` additionally reports what happened to the supervised MCP child
 * afterward: it parses policy once at spawn time and holds it in memory for
 * its whole process lifetime, so writing `policy.yaml` alone never reaches a
 * running child — the write needs to be followed by a restart for connected
 * agents to actually see the new policy. `server_restarted: true` means that
 * restart happened and the child is back up and running the new policy.
 * `server_restarted: false` with no `restart_error` means there was no
 * running child to restart in the first place (e.g. the user had stopped the
 * server) — nothing to report, nothing went wrong. `server_restarted: false`
 * WITH `restart_error` set means a child WAS running, the restart was
 * attempted, and it failed — display-safe (redacted where derived from
 * thrown/stored data). A failed restart never turns a successful save into
 * `ok: false`: the file write already succeeded, so the editor should show
 * the save as successful while surfacing the restart problem separately
 * (e.g. "quit and relaunch to apply changes").
 */
export type PolicyWriteResult =
  | { ok: true; server_restarted: boolean; restart_error?: string }
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

// ---- Connection management (list + remove linked items) -------------------

/**
 * Display-safe view of one linked item shown under a provider card on the
 * Connect screen. Deliberately carries ONLY non-secret metadata — an item id,
 * the institution name, the created date, and (SimpleFIN only) the distinct
 * institutions it spans. Never a Plaid access token or a SimpleFIN access URL
 * (this repo treats that as a hard security rule; see
 * `main/lib/connection-management.ts`). Structurally identical to that module's
 * own `LinkedItem`, kept as a standalone copy for the same layering reason as
 * `DashboardAccount`/`ApprovalListItem` above (this file must stay importable
 * from the renderer/preload build without reaching into `src/main/**`).
 */
export interface LinkedItem {
  itemId: string
  institutionName: string
  /** ISO-8601 timestamp the item was first stored. */
  createdAt: string
  /**
   * The distinct institutions this item spans, from the provider cache —
   * populated only for SimpleFIN (one access URL spans many institutions),
   * sorted and de-duplicated; `undefined` for Plaid (one item = one
   * institution, already named by `institutionName`) and when nothing is
   * cached yet. Deliberately institution-level, not account-level: the Connect
   * screen answers "which institutions are linked here", not "which accounts".
   */
  institutions?: string[]
}

/**
 * Result of removing (disconnecting) a linked item. `ok: true` with a set
 * `warning` means the item was deleted locally but a best-effort upstream
 * revocation (Plaid `/item/remove`) couldn't be completed — the item is gone
 * from this machine either way. Display-safe (redacted where derived from a
 * thrown provider error).
 */
export interface RemoveLinkedItemResult {
  ok: boolean
  warning?: string
  error?: string
}

/**
 * Result of a user-initiated SimpleFIN "Check for new accounts" — the manual
 * complement to the adapter's automatic setup-grace window. Display-safe:
 * counts and timings only, never an access URL or account detail. Standalone
 * copy of `main/lib/simplefin-refresh.ts`'s `SimpleFinForceRefreshResult` for
 * the same renderer-can't-import-`src/main/**` layering reason as `LinkedItem`.
 */
export interface SimpleFinForceRefreshResult {
  ok: boolean
  /** Items that made a live request and updated their cache. */
  refreshedCount: number
  /** Items skipped because they fetched within the 1-minute floor. */
  skippedCount: number
  /** `true` when the rolling daily budget refused at least one item. */
  budgetExhausted: boolean
  /** Requests spent in the rolling 24h window, after this call. */
  requestsInLastDay: number
  /** Display-safe; set when the passphrase isn't resolved, or a fetch failed. */
  error?: string
}

/**
 * Cooldown/budget status for the SimpleFIN card's refresh affordance — pure
 * cache read, never a fetch. `available: false` mirrors the connection's own
 * `'unavailable'` state (passphrase unresolved / store unreadable). Standalone
 * copy of `main/lib/simplefin-refresh.ts`'s `SimpleFinRefreshStatus`.
 */
export interface SimpleFinRefreshStatus {
  available: boolean
  /** Milliseconds until an automatic refresh is next allowed; `0` when due now. */
  msUntilRefreshAllowed: number
  /** `true` while at least one item is inside its post-setup grace window. */
  inSetupGrace: boolean
  /** Requests spent in the rolling 24h window. */
  requestsInLastDay: number
  /** Remaining force-refresh budget in the rolling 24h window. */
  forceRefreshBudgetRemaining: number
}

// ---- Connected clients / OAuth grants (D5.3 WS4 S1-S2) ---------------------

/**
 * Display-safe view of one issued OAuth grant. Standalone copy of
 * `@clad/core`'s `GrantMeta` (same layering rule as `LinkedItem`/
 * `ApprovalListItem` above: this file must stay importable from the
 * renderer/preload build without reaching into `src/main/**` or
 * `@clad/core`), field-for-field except `clientId` — `profileId` is the
 * trustworthy, server-chosen identity the Connected-clients section hangs
 * its hierarchy on (`main/lib/connected-clients.ts`'s `ConnectedClient`,
 * which this mirrors). NEVER a token, client secret, or authorization code.
 */
export interface ConnectedClient {
  grantId: string
  /**
   * Self-reported by the client at DCR (RFC 7591) — UNTRUSTED display text;
   * see `.claude/plans/d5.3/WS4-consent-revocation-ui.md` §7 "Client
   * identity display". Escape it, label it as reported, never imply
   * verification.
   */
  clientName?: string
  /** The bound agent profile — server-chosen at consent, immutable. The trustworthy field. */
  profileId: string
  /** Minted server-side from policy at consent (WS2 §6); rendered as scope chips. */
  scopes: string[]
  /** Whether this grant's token is sender-constrained (DPoP-bound; M3). */
  dpopBound: boolean
  createdAt: string
  /** Last time a request presented a token for this grant; `null` if never used. */
  lastUsedAt: string | null
  revoked: boolean
  /** Trust assurance recorded at consent (WS7 seam) — D5.3 only ever produces `'local-consent'`. */
  assuranceLevel: 'none' | 'local-consent' | 'attested'
  /** Highest scope sensitivity this grant's client may hold, recorded at consent (WS7 seam). */
  maxScopeSensitivity: 'low' | 'high'
}

export interface RevokeClientResult {
  ok: boolean
  /** Display-safe (redacted where derived from stored/thrown data). Never secret material. */
  error?: string
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
  // Connection management (list + remove linked items)
  connectListPlaidItems: 'connect:listPlaidItems',
  connectRemovePlaidItem: 'connect:removePlaidItem',
  connectListSimpleFinItems: 'connect:listSimpleFinItems',
  connectRemoveSimpleFinItem: 'connect:removeSimpleFinItem',
  connectSimpleFinForceRefresh: 'connect:simplefinForceRefresh',
  connectSimpleFinRefreshStatus: 'connect:simplefinRefreshStatus',
  // Connected clients / OAuth grants (D5.3 WS4 S1-S2)
  connectedClientsList: 'oauth:listClients',
  connectedClientsRevoke: 'oauth:revokeClient',
  /** Push-only, main -> renderer. See `onConnectedClientsChanged` below. */
  connectedClientsChanged: 'oauth:clientsChanged',
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
  /** Writes the entry AND puts `agentId` into force as the MCP server's identity (persists it, restarting the server if it changed). `agentId` should be whatever the last preview resolved to (`resolvedAgentId`, or the user's picked one) — see `ClaudeDesktopConnectPreview`'s doc comment. */
  connectClaudeDesktop(agentId?: string): Promise<OperationResult>
  /** Pure cache read — never triggers a fetch. See `DashboardSnapshot`'s doc comment. */
  getDashboardSnapshot(): Promise<DashboardSnapshot>
  /** The only call that ever triggers a live provider fetch — wire this to an explicit user action only, never a timer. */
  refreshDashboard(): Promise<DashboardSnapshot>
  /** Reads the policy file fresh from disk every call — no cache, no rate-limit concern (this is a local file, not a third-party API). */
  getPolicy(): Promise<PolicyGetResult>
  /**
   * Validates against `@clad/core`'s policy schema in the main process before
   * writing; never trusts the renderer's shape. See `main/lib/policy-data.ts`.
   * On success, also restarts the supervised MCP child so it picks up the new
   * policy (CLAD-5) — see `PolicyWriteResult`'s doc comment and
   * `main/lib/policy-save.ts`.
   */
  setPolicy(policy: PolicyDoc): Promise<PolicyWriteResult>
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
  /** Lists the Plaid items currently linked — display-safe metadata only, never tokens. Rejects only on a genuine store-read failure. */
  listPlaidItems(): Promise<LinkedItem[]>
  /** Disconnects a Plaid item: best-effort `/item/remove` revocation, then local token + cache deletion. Never rejects — failures come back as `{ ok: false, error }`. */
  removePlaidItem(itemId: string): Promise<RemoveLinkedItemResult>
  /** Lists the SimpleFIN items currently linked — display-safe metadata only, never access URLs. */
  listSimpleFinItems(): Promise<LinkedItem[]>
  /** Disconnects a SimpleFIN item locally (no revoke API exists for SimpleFIN). Never rejects — failures come back as `{ ok: false, error }`. */
  removeSimpleFinItem(itemId: string): Promise<RemoveLinkedItemResult>
  /**
   * User-initiated "Check for new accounts": makes a live SimpleFIN fetch
   * subject to a 1-minute floor and a rolling daily budget (NOT a quota
   * bypass — see `simplefin-refresh.ts`). Wire to an explicit click only.
   * Never rejects — failures come back as `{ ok: false, error }`.
   */
  forceRefreshSimpleFin(): Promise<SimpleFinForceRefreshResult>
  /** Pure cache read (never a fetch) for the SimpleFIN card's cooldown/budget display. */
  getSimpleFinRefreshStatus(): Promise<SimpleFinRefreshStatus>
  /**
   * Lists every OAuth grant issued to an MCP client (Claude Desktop, Claude
   * Code, ...) through this app's supervised MCP child — display-safe
   * metadata only, never a token/secret. Never rejects on a degraded grant
   * store (unresolved passphrase, undecryptable file) — comes back `[]`
   * instead; see `main/lib/connected-clients.ts`.
   */
  listConnectedClients(): Promise<ConnectedClient[]>
  /**
   * Revokes a single grant: the child's live token verification 401s the
   * very next request — no restart needed. Never rejects — failures come
   * back as `{ ok: false, error }`.
   */
  revokeConnectedClient(grantId: string): Promise<RevokeClientResult>
  /** Subscribes to live connected-clients list pushes (e.g. after a revoke). Returns an unsubscribe function — same shape as `onMcpStatusChanged`. */
  onConnectedClientsChanged(callback: (clients: ConnectedClient[]) => void): () => void
}

/** `start`/`stop`/`restartMcpServer` resolve once the *attempt* finishes, not necessarily to `'running'` (e.g. a crash pre-flight check fails synchronously) — callers read `.state`/`.lastError` same as any push update. */
export type McpProcessResult = McpServerStatus
