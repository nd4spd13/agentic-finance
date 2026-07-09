/**
 * Clad desktop app — Electron main process entry point.
 *
 * D1.1: config bootstrap, safeStorage passphrase custody (with the CLI
 * migration flow), and Plaid credential storage. D1.2: MCP server lifecycle
 * (start/stop/restart, crash backoff, status pushed to the renderer). D1.3:
 * tray/menu-bar presence (server status + pending approvals, single-instance
 * lock, close-to-tray). D1.4: "Connect to Claude Desktop" (non-destructive
 * config merge behind a confirm dialog). All wired over the typed IPC
 * contract in `../shared/ipc.js`.
 *
 * Security posture (desktop-app.md, non-negotiable):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true.
 *  - All secret material (passphrase, Plaid credentials, tokens, DB
 *    handles) stays in this process. Only display-safe view models
 *    (`DisplayConfig`, `MigrationStatus`, `OperationResult`,
 *    `McpServerStatus`, `ClaudeDesktopConnectPreview`) cross IPC.
 */

import { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage } from 'electron'
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
import { getPendingApprovalsCount } from './lib/approvals.js'
import { trayTooltip, trayServerStatusMenuLabel, trayApprovalsMenuLabel } from './lib/tray-status.js'
import { shouldQuitOnAllWindowsClosed } from './lib/window-lifecycle.js'
import { claudeDesktopConfigPath } from './lib/claude-desktop-path.js'
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

async function withPendingApprovals(status: McpProcessStatus): Promise<McpServerStatus> {
  const pendingApprovals = await getPendingApprovalsCount(loadConfig().approval_db)
  return { ...status, pendingApprovals }
}

/** Pushes the merged status to the renderer (if a window is open) AND repaints the tray. Single source of truth for "what changed" — see updateTray below. */
async function broadcastStatus(): Promise<void> {
  const status = await withPendingApprovals(latestMcpStatus)
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
    hasPlaidCredentials: getPlaidSecrets().has(),
    closeToTray: config.close_to_tray,
  }
}

/**
 * A CLI-style store is "detected" when the configured `plaid_db` already
 * exists on disk but this app has never resolved passphrase custody for it
 * (no `passphrase.bin` yet). Once custody is resolved — generated or
 * migrated — this is permanently `false` for that install; see
 * `passphrase.ts`'s module doc for the full migration decision.
 */
function computeMigrationStatus(): MigrationStatus {
  const config = loadConfig()
  const needed = !getPassphraseCustody().hasCustodyFile() && existsSync(config.plaid_db)
  return { needed, plaidDbPath: config.plaid_db }
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
 */
function trayIconPath(): string {
  return join(__dirname, '../../resources/trayIconTemplate.png')
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
 * Repaints the tray's tooltip + context menu from a fresh status. Called
 * from every place `latestMcpStatus` can change (the manager's
 * `onStatusChange` callback, via `broadcastStatus`) and from the periodic
 * pending-approvals refresh below — approvals can change from agent
 * activity alone, independent of any MCP process state transition, so
 * polling is what keeps the tray from going stale between them (interval:
 * 15s, shared with the settings window's own refresh — see
 * `app.whenReady()`).
 */
function updateTray(status: McpServerStatus): void {
  if (!tray) return
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
  const icon = nativeImage.createFromPath(trayIconPath())
  // Electron auto-detects the "Template" filename suffix on macOS, but
  // setting this explicitly documents the intent and doesn't depend on the
  // asset never being renamed. Harmless no-op on Windows/Linux.
  icon.setTemplateImage(true)
  tray = new Tray(icon)
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

// ---- IPC handlers (D1.4) ---------------------------------------------------

/** The real Claude Desktop config path — the only place in the app that calls `app.getPath('appData')` for this purpose (see claude-desktop-path.ts's module doc). */
function getClaudeDesktopConfigPath(): string {
  return claudeDesktopConfigPath(app.getPath('appData'))
}

function buildClaudeDesktopPreview(): ClaudeDesktopConnectPreview {
  const configPath = getClaudeDesktopConfigPath()
  const installed = isClaudeDesktopInstalled(configPath)
  const existing = readExistingConfig(configPath)
  const cladEntry = buildCladMcpServerEntry(loadConfig(), process.execPath)
  const merged = mergeCladEntry(existing, cladEntry)

  return {
    installed,
    configPath,
    currentConfigJson: existsSync(configPath) ? JSON.stringify(existing, null, 2) : null,
    proposedConfigJson: JSON.stringify(merged, null, 2),
    alreadyConnected: isAlreadyConnected(existing, cladEntry),
  }
}

ipcMain.handle(
  IPC_CHANNELS.claudeDesktopGetPreview,
  (): ClaudeDesktopConnectPreview => buildClaudeDesktopPreview()
)

ipcMain.handle(IPC_CHANNELS.claudeDesktopConnect, (): OperationResult => {
  try {
    const configPath = getClaudeDesktopConfigPath()
    if (!isClaudeDesktopInstalled(configPath)) {
      return {
        ok: false,
        error:
          'Claude Desktop was not found on this machine (its application-support folder is missing). Install Claude Desktop, launch it at least once, then try again.',
      }
    }
    const existing = readExistingConfig(configPath)
    const cladEntry = buildCladMcpServerEntry(loadConfig(), process.execPath)
    const merged = mergeCladEntry(existing, cladEntry)
    writeClaudeDesktopConfig(configPath, merged)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

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
