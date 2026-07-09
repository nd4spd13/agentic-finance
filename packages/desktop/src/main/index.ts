/**
 * Clad desktop app — Electron main process entry point.
 *
 * D1.1: config bootstrap, safeStorage passphrase custody (with the CLI
 * migration flow), and Plaid credential storage. D1.2: MCP server lifecycle
 * (start/stop/restart, crash backoff, status pushed to the renderer). D1.3:
 * tray/menu-bar presence (server status + pending approvals, single-instance
 * lock, close-to-tray). D1.4: "Connect to Claude Desktop" (non-destructive
 * config merge behind a confirm dialog). D2.1: approvals inbox (list/
 * approve/deny through the real `@clad/core` `ApprovalQueue`, audit-logged,
 * plus a native OS notification on new pending approvals — see
 * `broadcastStatus`/`notifyNewApproval` below). D2.2: read-only paginated
 * audit log viewer. All wired over the typed IPC contract in
 * `../shared/ipc.js`.
 *
 * Security posture (desktop-app.md, non-negotiable):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true.
 *  - All secret material (passphrase, Plaid credentials, tokens, DB
 *    handles) stays in this process. Only display-safe view models
 *    (`DisplayConfig`, `MigrationStatus`, `OperationResult`,
 *    `McpServerStatus`, `ClaudeDesktopConnectPreview`, `ApprovalListItem`,
 *    `AuditLogPage`) cross IPC.
 */

import { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage, Notification } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureConfigBootstrap,
  loadConfig,
  saveConfig,
  getConfigDir,
  desktopOnlyPlaidDbPath,
} from './lib/config.js'
import { PassphraseCustody, verifyCliPassphrase } from './lib/passphrase.js'
import { PlaidSecretsStore } from './lib/plaid-secrets.js'
import { McpServerManager, type McpProcessStatus } from './lib/mcp-server-manager.js'
import { listApprovals, decideApproval, findNewPendingApprovals } from './lib/approvals.js'
import { queryAuditLog } from './lib/audit-log.js'
import { DashboardDataStore, type DashboardSnapshot } from './lib/dashboard-data.js'
import { readPolicy, writePolicy, type PolicyGetResult, type PolicyWriteResult } from './lib/policy-data.js'
import {
  PlaidLinkFlowManager,
  getPlaidConnectionState,
  type PlaidLinkFlowStatus,
} from './lib/plaid-link-flow.js'
import {
  claimAndStoreSimpleFinToken,
  getSimpleFinConnectionState,
  type SimpleFinConnectResult,
} from './lib/simplefin-connect.js'
import {
  trayTooltip,
  trayServerStatusMenuLabel,
  trayApprovalsMenuLabel,
  trayIconVariantForStatus,
  type TrayIconVariant,
} from './lib/tray-status.js'
import { shouldQuitOnAllWindowsClosed } from './lib/window-lifecycle.js'
import { claudeDesktopConfigPath } from './lib/claude-desktop-path.js'
import { resolveClaudeDesktopAgentId } from './lib/agent-resolution.js'
import {
  buildCladMcpServerEntry,
  isClaudeDesktopInstalled,
  readExistingConfig,
  mergeCladEntry,
  isAlreadyConnected,
  writeConfig as writeClaudeDesktopConfig,
} from './lib/claude-desktop-config.js'
import {
  IPC_CHANNELS,
  type DisplayConfig,
  type SetProviderAndEnvInput,
  type SetCloseToTrayInput,
  type SetPlaidCredentialsInput,
  type OperationResult,
  type MigrationStatus,
  type McpServerStatus,
  type ClaudeDesktopConnectPreview,
  type ApprovalListItem,
  type ApprovalsListInput,
  type ApprovalDecisionInput,
  type ApprovalDecisionResult,
  type AuditLogQueryInput,
  type AuditLogPage,
  type ConnectProvidersStatus,
  type StartPlaidLinkInput,
} from '../shared/ipc.js'

// `__dirname` (ambient via @types/node) is a CommonJS global — valid here
// because electron-vite's default main-process build output is CJS (see
// electron.vite.config.ts).

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let passphraseCustodySingleton: PassphraseCustody | null = null
let plaidSecretsSingleton: PlaidSecretsStore | null = null

function getPassphraseCustody(): PassphraseCustody {
  if (!passphraseCustodySingleton) {
    passphraseCustodySingleton = new PassphraseCustody(app.getPath('userData'), safeStorage)
  }
  return passphraseCustodySingleton
}

function getPlaidSecrets(): PlaidSecretsStore {
  if (!plaidSecretsSingleton) {
    plaidSecretsSingleton = new PlaidSecretsStore(app.getPath('userData'), safeStorage)
  }
  return plaidSecretsSingleton
}

/**
 * The passphrase the MCP server child should use for `CLAD_TOKEN_PASSPHRASE`
 * when the `plaid` provider is selected. Deliberately returns `null` (never
 * auto-generates) while CLI migration is still pending — same rule as the
 * eager resolution in `app.whenReady()` below; see `passphrase.ts`'s
 * `getOrCreate` doc comment for why.
 */
function getActiveTokenStorePassphrase(): string | null {
  if (computeMigrationStatus().needed) return null
  return getPassphraseCustody().getOrCreate().passphrase
}

let latestMcpStatus: McpProcessStatus = { state: 'stopped', tools: [], restartAttempt: 0 }
let statusRefreshTimer: ReturnType<typeof setInterval> | null = null

/**
 * D2.1's "new pending approval" detection state — an id set from the
 * previous tick, diffed via `findNewPendingApprovals` (pure, unit-tested in
 * `approvals.test.ts`). Deliberately uninitialized (`null`) until the first
 * tick: that first tick seeds this set from whatever's already pending
 * without notifying — otherwise every approval that existed before the app
 * even started watching would fire a notification on launch, which is noise,
 * not news. `broadcastStatus` below is the ONLY place this is read/written —
 * see its doc comment for why detection lives there instead of in
 * `withPendingApprovals` (used by several other call sites that shouldn't
 * also drive notifications).
 */
let seenPendingApprovalIds: Set<string> | null = null

/** Best-effort: a failure to list approvals here shouldn't take down the tray/status refresh loop (same posture as `getPendingApprovalsCount`'s own try/catch, which this replaces for callers that need the full list too). */
async function loadPendingApprovalsSafe(): Promise<ApprovalListItem[]> {
  try {
    return await listApprovals(loadConfig().approval_db, { status: 'pending' })
  } catch {
    return []
  }
}

async function withPendingApprovals(status: McpProcessStatus): Promise<McpServerStatus> {
  const pendingApprovals = (await loadPendingApprovalsSafe()).length
  return { ...status, pendingApprovals }
}

/**
 * Shows a native OS notification for a newly-appeared pending approval.
 * Clicking it focuses/creates the main window and pushes
 * `approvalFocusRequested` with the approval's id so the renderer can
 * switch to the Approvals tab and scroll-to/highlight that item (see
 * `App.tsx`'s subscription and `ApprovalsInbox.tsx`'s `focusApprovalId`
 * prop). Guarded by `isSupported()` the same way `safeStorage` is checked
 * elsewhere — some Linux desktop environments have no notification daemon.
 */
function notifyNewApproval(approval: ApprovalListItem): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: 'New approval request',
    body: `${approval.agentId} wants to run ${approval.toolName} — ${approval.triggerReason}`,
  })
  notification.on('click', () => {
    focusOrCreateWindow()
    mainWindow?.webContents.send(IPC_CHANNELS.approvalFocusRequested, { id: approval.id })
  })
  notification.show()
}

/**
 * Pushes the merged status to the renderer (if a window is open) AND
 * repaints the tray. Single source of truth for "what changed" — see
 * updateTray below. Also the single place the D2.1 new-pending-approval
 * notification is driven from: it already runs on the exact cadence the
 * plan calls for extending (every real MCP status change via
 * `onStatusChange` below, plus the 15s interval in `app.whenReady()`) —
 * deliberately NOT added to `withPendingApprovals` itself, since that's also
 * called from `mcpGetStatus`/`mcpStart`/`mcpStop`/`mcpRestart` IPC handlers,
 * which would turn one poll loop into several independent notification
 * triggers.
 */
async function broadcastStatus(): Promise<void> {
  const pending = await loadPendingApprovalsSafe()
  if (seenPendingApprovalIds === null) {
    seenPendingApprovalIds = new Set(pending.map((item) => item.id))
  } else {
    const fresh = findNewPendingApprovals(seenPendingApprovalIds, pending)
    seenPendingApprovalIds = new Set(pending.map((item) => item.id))
    for (const approval of fresh) {
      notifyNewApproval(approval)
    }
  }

  const status: McpServerStatus = { ...latestMcpStatus, pendingApprovals: pending.length }
  mainWindow?.webContents.send(IPC_CHANNELS.mcpStatusChanged, status)
  updateTray(status)
}

const mcpManager = new McpServerManager({
  loadConfig,
  loadPlaidCredentials: () => getPlaidSecrets().load(),
  getActivePassphrase: getActiveTokenStorePassphrase,
  onStatusChange: (status) => {
    latestMcpStatus = status
    void broadcastStatus()
  },
})

// D2.3: same DI shape as McpServerManager above — constructs its provider
// through main/lib/provider-factory.ts (dummy or plaid, same factory pattern
// mcp-server's own provider-factory.ts uses) rather than owning any
// provider-specific logic itself, so a future SimpleFIN provider slots in
// with no change here.
const dashboardStore = new DashboardDataStore({
  loadConfig,
  loadPlaidCredentials: () => getPlaidSecrets().load(),
  getActivePassphrase: getActiveTokenStorePassphrase,
})

// D3.1: same DI shape as McpServerManager/DashboardDataStore above.
// `openExternal` is the one real Electron dependency this needs — see
// `plaid-link-flow.ts`'s module doc for why the system browser (not a
// BrowserWindow) is the right call here, and `isExpectedPlaidLinkUrl`'s doc
// comment for why the URL is validated before ever reaching it (security
// checklist item 4). `isDevBuild` gates the sandbox-auto (no-browser) path
// the same way `connect.ts` gates `--sandbox-auto` on `PLAID_ENV=sandbox`,
// plus an additional "not a packaged build at all" check — sandbox-auto has
// no place in a build an end user might run against their own account.
const plaidLinkFlow = new PlaidLinkFlowManager({
  loadConfig,
  loadPlaidCredentials: () => getPlaidSecrets().load(),
  getActivePassphrase: getActiveTokenStorePassphrase,
  openExternal: (url) => shell.openExternal(url),
  isDevBuild: () => !app.isPackaged,
  onStatusChange: (status) => {
    mainWindow?.webContents.send(IPC_CHANNELS.plaidLinkStatusChanged, status)
  },
})

function buildDisplayConfig(): DisplayConfig {
  const config = loadConfig()
  return {
    configDir: getConfigDir(),
    policyPath: config.policy_path,
    auditDbPath: config.audit_db,
    approvalDbPath: config.approval_db,
    plaidDbPath: config.plaid_db,
    provider: config.provider,
    plaidEnv: config.plaid_env,
    plaidCredentialsStatus: getPlaidSecrets().status(),
    closeToTray: config.close_to_tray,
  }
}

/**
 * Two independent reasons the one-time migration/recovery prompt needs to
 * show (see `MigrationReason` in `shared/ipc.ts`):
 *
 *  - `'cli-store-detected'`: the configured `plaid_db` already exists on
 *    disk but this app has never resolved passphrase custody for it (no
 *    `passphrase.bin` yet). Once custody is resolved — generated or
 *    migrated — this is permanently moot for that install; see
 *    `passphrase.ts`'s module doc for the full migration decision.
 *  - `'passphrase-undecryptable'` (D1 manual QA finding 3): a passphrase WAS
 *    sealed, but `probeCustody()` — a read-only check, never `getOrCreate()`
 *    — finds this OS keychain can no longer open it. Deliberately uses
 *    `probeCustody()` rather than `getOrCreate()` here: `getOrCreate()` would
 *    happily fabricate and seal a brand-new random passphrase if no file
 *    existed yet, which is wrong to risk as a side effect of a status check
 *    reached from the `cli-store-detected` branch below too.
 */
function computeMigrationStatus(): MigrationStatus {
  const config = loadConfig()
  const custody = getPassphraseCustody()

  if (custody.hasCustodyFile()) {
    if (custody.probeCustody() === 'undecryptable') {
      return { needed: true, reason: 'passphrase-undecryptable', plaidDbPath: config.plaid_db }
    }
    return { needed: false, plaidDbPath: config.plaid_db }
  }

  const needed = existsSync(config.plaid_db)
  return { needed, reason: needed ? 'cli-store-detected' : undefined, plaidDbPath: config.plaid_db }
}

// ---- Tray (D1.3) ------------------------------------------------------------

/**
 * Resources ship alongside the built main bundle: `out/main/../../resources`
 * resolves to `<project>/resources` in dev (`electron-vite dev`) and against
 * an unpacked `out/` tree, and to `app.asar/resources` in the packaged app —
 * `resources/**` is included in electron-builder's `files` list precisely so
 * this path exists there too. `nativeImage.createFromPath` is asar-
 * transparent, same principle S0.4 already established for spawning
 * mcp-server's script path from inside `app.asar`.
 *
 * Two variants (D1 manual QA finding 4 — see `tray-status.ts`'s
 * `trayIconVariantForStatus` doc comment): `trayIconTemplate.png` is the
 * normal monochrome menu-bar glyph (a macOS "template" image — the OS tints
 * it automatically for light/dark menu bars); `trayIconAlert.png` is the
 * same glyph with a small red badge baked in for the `crashed` state, shown
 * as real color (NOT a template image — macOS template images are
 * rendered monochrome from their alpha channel only, which would throw away
 * the red). Each has an `@2x` sibling alongside it that
 * `nativeImage.createFromPath` picks up automatically for Retina displays.
 */
function trayIconPath(variant: TrayIconVariant): string {
  const filename = variant === 'alert' ? 'trayIconAlert.png' : 'trayIconTemplate.png'
  return join(__dirname, '../../resources', filename)
}

/** Loaded once per variant and cached — the tray icon can change on every status push (every MCP state transition, every 15s approvals refresh), so this avoids re-reading + re-decoding the PNG from disk each time. */
const trayIconCache = new Map<TrayIconVariant, ReturnType<typeof nativeImage.createFromPath>>()

function getTrayIcon(variant: TrayIconVariant): ReturnType<typeof nativeImage.createFromPath> {
  let icon = trayIconCache.get(variant)
  if (!icon) {
    icon = nativeImage.createFromPath(trayIconPath(variant))
    // Electron auto-detects the "Template" filename suffix on macOS, but
    // setting this explicitly documents the intent and doesn't depend on
    // the asset never being renamed. The alert variant carries real color
    // (a red badge) and must NOT be template-tinted away to monochrome.
    icon.setTemplateImage(variant === 'default')
    trayIconCache.set(variant, icon)
  }
  return icon
}

function focusOrCreateWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

/**
 * Repaints the tray's icon + tooltip + context menu from a fresh status.
 * Called from every place `latestMcpStatus` can change (the manager's
 * `onStatusChange` callback, via `broadcastStatus`) and from the periodic
 * pending-approvals refresh below — approvals can change from agent
 * activity alone, independent of any MCP process state transition, so
 * polling is what keeps the tray from going stale between them (interval:
 * 15s, shared with the settings window's own refresh — see
 * `app.whenReady()`).
 *
 * D1 manual QA finding 4: the context menu built below can't repaint while
 * it's already open (macOS NSMenu limitation, accepted — the labels only
 * refresh next time it's opened). The icon and tooltip set just above it
 * have no such limitation, so they're what actually gives live feedback —
 * e.g. the icon swapping to the alert variant the moment the server crashes,
 * even if the user is mid-way through looking at the (now stale) menu.
 */
function updateTray(status: McpServerStatus): void {
  if (!tray) return
  tray.setImage(getTrayIcon(trayIconVariantForStatus(status)))
  tray.setToolTip(trayTooltip(status))
  const menu = Menu.buildFromTemplate([
    { label: trayServerStatusMenuLabel(status), enabled: false },
    { label: trayApprovalsMenuLabel(status), enabled: false },
    { type: 'separator' },
    { label: 'Open Clad', click: () => focusOrCreateWindow() },
    { type: 'separator' },
    { label: 'Quit Clad', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
}

function createTray(): void {
  tray = new Tray(getTrayIcon('default'))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // External links open in the system browser, never in-app (security checklist item 4).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(mainWindow!.webContents.getURL()).origin) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  // D1.3: closing the window (titlebar close control / Cmd+W) hides it —
  // the app + tray stay running — unless the user turned this off in
  // Settings (`close_to_tray`, defaults to `true`). A real app quit never
  // reaches this: it goes through `before-quit` -> `app.exit(0)` below,
  // which terminates the process directly without dispatching a 'close'
  // event on any window.
  mainWindow.on('close', (event) => {
    if (loadConfig().close_to_tray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- IPC handlers (D1.1) ---------------------------------------------------

ipcMain.handle(IPC_CHANNELS.configGet, () => buildDisplayConfig())

ipcMain.handle(
  IPC_CHANNELS.configSetProviderAndEnv,
  (_event, input: SetProviderAndEnvInput): OperationResult => {
    try {
      const config = loadConfig()
      saveConfig({ ...config, provider: input.provider, plaid_env: input.plaidEnv })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
)

ipcMain.handle(
  IPC_CHANNELS.configSetCloseToTray,
  (_event, input: SetCloseToTrayInput): OperationResult => {
    try {
      const config = loadConfig()
      saveConfig({ ...config, close_to_tray: input.closeToTray })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
)

ipcMain.handle(IPC_CHANNELS.plaidCredentialsHas, () => getPlaidSecrets().has())

ipcMain.handle(
  IPC_CHANNELS.plaidCredentialsSet,
  (_event, input: SetPlaidCredentialsInput): OperationResult => getPlaidSecrets().save(input)
)

ipcMain.handle(IPC_CHANNELS.plaidCredentialsClear, (): OperationResult => {
  getPlaidSecrets().clear()
  return { ok: true }
})

ipcMain.handle(IPC_CHANNELS.migrationGetStatus, () => computeMigrationStatus())

ipcMain.handle(
  IPC_CHANNELS.migrationSubmitCliPassphrase,
  async (_event, passphrase: string): Promise<OperationResult> => {
    const config = loadConfig()
    const verified = await verifyCliPassphrase(config.plaid_db, passphrase)
    if (!verified.ok) {
      return { ok: false, error: verified.error }
    }
    const result = getPassphraseCustody().adoptPassphrase(passphrase)
    return { ok: result.ok, error: result.error }
  }
)

ipcMain.handle(IPC_CHANNELS.migrationStartFresh, (): OperationResult => {
  try {
    const config = loadConfig()
    saveConfig({ ...config, plaid_db: desktopOnlyPlaidDbPath() })
    const { result } = getPassphraseCustody().resetToFreshRandom()
    return { ok: result.ok, error: result.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// ---- IPC handlers (D1.2) ---------------------------------------------------

ipcMain.handle(IPC_CHANNELS.mcpGetStatus, () => withPendingApprovals(mcpManager.getStatus()))
ipcMain.handle(IPC_CHANNELS.mcpStart, async () => withPendingApprovals(await mcpManager.start()))
ipcMain.handle(IPC_CHANNELS.mcpStop, async () => withPendingApprovals(await mcpManager.stop()))
ipcMain.handle(IPC_CHANNELS.mcpRestart, async () => withPendingApprovals(await mcpManager.restart()))

// ---- IPC handlers (D2.3) ---------------------------------------------------

// getDashboardSnapshot is a pure cache read (no network); refreshDashboard is
// the only path that ever calls the provider — see dashboard-data.ts's
// module doc for the rate-limit discipline this encodes.
ipcMain.handle(
  IPC_CHANNELS.dashboardGetSnapshot,
  (): DashboardSnapshot => dashboardStore.getSnapshot()
)
ipcMain.handle(
  IPC_CHANNELS.dashboardRefresh,
  (): Promise<DashboardSnapshot> => dashboardStore.refresh()
)

// ---- IPC handlers (D2.4) ---------------------------------------------------

// Always reads the config fresh (loadConfig()) rather than caching
// policy_path, the same way the D1.1 config handlers above do — picks up a
// policy_path change from Settings without requiring an app restart.
ipcMain.handle(
  IPC_CHANNELS.policyGet,
  (): Promise<PolicyGetResult> => readPolicy(loadConfig().policy_path)
)
ipcMain.handle(
  IPC_CHANNELS.policySet,
  (_event, policy: unknown): Promise<PolicyWriteResult> => writePolicy(loadConfig().policy_path, policy)
)

// ---- IPC handlers (D1.4) ---------------------------------------------------

/** The real Claude Desktop config path — the only place in the app that calls `app.getPath('appData')` for this purpose (see claude-desktop-path.ts's module doc). */
function getClaudeDesktopConfigPath(): string {
  return claudeDesktopConfigPath(app.getPath('appData'))
}

/**
 * Resolves the agent id + builds the merged config for a given (optional)
 * user-picked `selectedAgentId` — shared by the preview and the actual write
 * so they can never disagree about which agent id ends up in `CLAD_AGENT_ID`
 * (D1 manual QA finding 2). See `agent-resolution.ts`'s module doc.
 */
async function computeClaudeDesktopMerge(selectedAgentId: string | undefined): Promise<{
  configPath: string
  existing: Record<string, unknown>
  merged: Record<string, unknown>
  cladEntry: ReturnType<typeof buildCladMcpServerEntry>
  resolution: Awaited<ReturnType<typeof resolveClaudeDesktopAgentId>>
}> {
  const configPath = getClaudeDesktopConfigPath()
  const existing = readExistingConfig(configPath)
  const config = loadConfig()
  const resolution = await resolveClaudeDesktopAgentId(config.policy_path, selectedAgentId)
  const cladEntry = buildCladMcpServerEntry(config, process.execPath, resolution.agentId)
  const merged = mergeCladEntry(existing, cladEntry)
  return { configPath, existing, merged, cladEntry, resolution }
}

async function buildClaudeDesktopPreview(selectedAgentId?: string): Promise<ClaudeDesktopConnectPreview> {
  const { configPath, existing, merged, cladEntry, resolution } =
    await computeClaudeDesktopMerge(selectedAgentId)

  return {
    installed: isClaudeDesktopInstalled(configPath),
    configPath,
    currentConfigJson: existsSync(configPath) ? JSON.stringify(existing, null, 2) : null,
    proposedConfigJson: JSON.stringify(merged, null, 2),
    alreadyConnected: isAlreadyConnected(existing, cladEntry),
    availableAgentIds: resolution.availableAgentIds,
    resolvedAgentId: resolution.agentId,
    agentFallbackReason: resolution.fallbackReason,
  }
}

ipcMain.handle(
  IPC_CHANNELS.claudeDesktopGetPreview,
  (_event, agentId?: string): Promise<ClaudeDesktopConnectPreview> => buildClaudeDesktopPreview(agentId)
)

ipcMain.handle(IPC_CHANNELS.claudeDesktopConnect, async (_event, agentId?: string): Promise<OperationResult> => {
  try {
    const configPath = getClaudeDesktopConfigPath()
    if (!isClaudeDesktopInstalled(configPath)) {
      return {
        ok: false,
        error:
          'Claude Desktop was not found on this machine (its application-support folder is missing). Install Claude Desktop, launch it at least once, then try again.',
      }
    }
    const { merged } = await computeClaudeDesktopMerge(agentId)
    writeClaudeDesktopConfig(configPath, merged)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// ---- IPC handlers (D2.1 approvals inbox) -----------------------------------

// Unlike the mutation-style handlers above, this one does NOT catch: a
// genuine read failure should reject the renderer's `invoke()` call so
// `ApprovalsInbox.tsx` shows a real error state (with Retry) instead of a
// silently-empty inbox — see `listApprovals`'s doc comment in
// `main/lib/approvals.ts`. Electron only serializes the thrown error's
// `.message` across IPC, which is display-safe here (SQLite/fs error text,
// never secret material).
ipcMain.handle(
  IPC_CHANNELS.approvalsList,
  (_event, input?: ApprovalsListInput): Promise<ApprovalListItem[]> =>
    listApprovals(loadConfig().approval_db, input?.status ? { status: input.status } : undefined)
)

ipcMain.handle(
  IPC_CHANNELS.approvalsDecide,
  async (_event, input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> => {
    const config = loadConfig()
    const result = await decideApproval(config.approval_db, config.audit_db, input.id, input.decision)
    // Keep the tray/status-panel pending count consistent with the decision
    // immediately, rather than waiting up to 15s for the next interval tick.
    if (result.ok) void broadcastStatus()
    return result
  }
)

// ---- IPC handlers (D2.2 audit log viewer) ----------------------------------

// Same no-catch posture as approvalsList above: a real read failure should
// surface as a genuine error state in `AuditLogViewer.tsx`, not an empty page.
ipcMain.handle(
  IPC_CHANNELS.auditLogQuery,
  (_event, input: AuditLogQueryInput): Promise<AuditLogPage> =>
    queryAuditLog(loadConfig().audit_db, input.filter ?? {}, input.page, input.pageSize)
)

// ---- IPC handlers (D3.1 Plaid Link / D3.2 connect UI) ----------------------

ipcMain.handle(IPC_CHANNELS.connectGetProvidersStatus, async (): Promise<ConnectProvidersStatus> => {
  const deps = { loadConfig, getActivePassphrase: getActiveTokenStorePassphrase }
  const [plaidConnection, simplefinConnection] = await Promise.all([
    getPlaidConnectionState(deps),
    getSimpleFinConnectionState(deps),
  ])
  return {
    plaidCredentialsConfigured: getPlaidSecrets().has(),
    plaidConnection,
    simplefinConnection,
    sandboxAutoAvailable: !app.isPackaged,
  }
})

ipcMain.handle(
  IPC_CHANNELS.plaidLinkStart,
  (_event, input?: StartPlaidLinkInput): Promise<PlaidLinkFlowStatus> => plaidLinkFlow.start(input)
)
ipcMain.handle(IPC_CHANNELS.plaidLinkCancel, (): PlaidLinkFlowStatus => plaidLinkFlow.cancel())
ipcMain.handle(IPC_CHANNELS.plaidLinkGetStatus, (): PlaidLinkFlowStatus => plaidLinkFlow.getStatus())

ipcMain.handle(
  IPC_CHANNELS.simplefinConnect,
  (_event, setupToken: string): Promise<SimpleFinConnectResult> =>
    claimAndStoreSimpleFinToken(setupToken, { loadConfig, getActivePassphrase: getActiveTokenStorePassphrase })
)

// ---- App lifecycle ----------------------------------------------------------

// D1.3: only one instance of the app runs at a time. A second launch
// attempt (double-clicking the app again, running `electron .` twice, etc.)
// just focuses the existing window instead of starting a second supervised
// MCP server child against the same `~/.clad` config dir/SQLite files,
// which would otherwise race over the same on-disk state.
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusOrCreateWindow()
  })

  app.whenReady().then(async () => {
    ensureConfigBootstrap()

    // Resolve passphrase custody eagerly on the common path (no pre-existing
    // CLI store). When migration is needed, leave it unresolved — the
    // renderer prompts the user, which drives migrationSubmitCliPassphrase /
    // migrationStartFresh above. Calling getOrCreate() here unconditionally
    // would otherwise happily fabricate a fresh random passphrase in front of
    // an already-initialized store, which is exactly the wrong thing to do
    // (see passphrase.ts's getOrCreate doc comment).
    if (!computeMigrationStatus().needed) {
      getPassphraseCustody().getOrCreate()
    }

    createTray()
    createWindow()

    // Auto-start the app's own supervised MCP server on launch — this is what
    // the tray and the settings window's status panel reflect. Note this is a
    // SEPARATE process from whatever Claude Desktop spawns via its own config
    // (D1.4): MCP's stdio transport is a 1:1 parent/child pipe, so a single
    // running server process can't be shared between two unrelated parents.
    // If provider=plaid but credentials/passphrase aren't ready yet, start()
    // reports 'crashed' with a clear lastError instead of throwing —
    // surfaced in the status panel/tray, not a startup crash.
    void mcpManager.start()

    // Paint the tray immediately with whatever status/approvals count is
    // known right now, rather than leaving it blank until the first
    // onStatusChange fires or the interval below first ticks.
    void broadcastStatus()

    // Pending-approvals can change from agent activity alone, independent of
    // MCP process state — refresh periodically so the tray/status panel don't
    // go stale between state-change-triggered pushes. Interval: 15s.
    statusRefreshTimer = setInterval(() => {
      void broadcastStatus()
    }, 15_000)

    app.on('activate', () => {
      if (mainWindow) {
        mainWindow.show()
      } else {
        createWindow()
      }
    })
  })

  // Fixed D1 manual QA finding 1: this used to be the stock Electron
  // boilerplate `if (process.platform !== 'darwin') app.quit()`, which keyed
  // quitting off the OS instead of `close_to_tray` — on macOS the app never
  // quit this way at all, even with `close_to_tray` off. See
  // `window-lifecycle.ts`'s module doc for the full decision.
  app.on('window-all-closed', () => {
    if (shouldQuitOnAllWindowsClosed(loadConfig())) {
      app.quit()
    }
  })

  let cleaningUp = false
  app.on('before-quit', async (event) => {
    if (cleaningUp) return
    cleaningUp = true
    event.preventDefault()
    if (statusRefreshTimer) clearInterval(statusRefreshTimer)
    // Stops this app from watching an in-flight Plaid Link flow (if any) —
    // see plaid-link-flow.ts's module doc: the actual loopback server this
    // may have left running has no external close handle, so it's the
    // `app.exit(0)` below (ending the whole process) that really tears it
    // down, not this call. Still worth calling for tidiness/consistency with
    // every other resource cleaned up here.
    plaidLinkFlow.cancel()
    // Closes the MCP client + transport, which sends SIGTERM (then SIGKILL
    // after a grace period) to the spawned server child — verified via `ps`
    // in S0.4 to leave no orphaned process behind.
    await mcpManager.stop()
    app.exit(0)
  })

  // Electron does not wire OS termination signals to `app.quit()` on its own
  // (SIGTERM/SIGINT would otherwise kill the process abruptly, leaving the
  // spawned MCP server child orphaned). Route them through the same
  // before-quit cleanup path so `pkill`/process-manager stop and Ctrl-C in a
  // terminal both shut the app down cleanly.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      app.quit()
    })
  }
}
