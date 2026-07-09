/**
 * Clad desktop app — Electron main process entry point.
 *
 * D1.1: config bootstrap, safeStorage passphrase custody (with the CLI
 * migration flow), and Plaid credential storage. D1.2: MCP server lifecycle
 * (start/stop/restart, crash backoff, status pushed to the renderer). All
 * wired over the typed IPC contract in `../shared/ipc.js`. D1.3
 * (tray/menu-bar) and D1.4 (Connect to Claude Desktop) extend this file in
 * later commits.
 *
 * Security posture (desktop-app.md, non-negotiable):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true.
 *  - All secret material (passphrase, Plaid credentials, tokens, DB
 *    handles) stays in this process. Only display-safe view models
 *    (`DisplayConfig`, `MigrationStatus`, `OperationResult`,
 *    `McpServerStatus`) cross IPC.
 */

import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
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
import {
  IPC_CHANNELS,
  type DisplayConfig,
  type SetProviderAndEnvInput,
  type SetPlaidCredentialsInput,
  type OperationResult,
  type MigrationStatus,
  type McpServerStatus,
} from '../shared/ipc.js'

// `__dirname` (ambient via @types/node) is a CommonJS global — valid here
// because electron-vite's default main-process build output is CJS (see
// electron.vite.config.ts).

let mainWindow: BrowserWindow | null = null
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

async function broadcastStatus(): Promise<void> {
  const status = await withPendingApprovals(latestMcpStatus)
  mainWindow?.webContents.send(IPC_CHANNELS.mcpStatusChanged, status)
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

// ---- App lifecycle ----------------------------------------------------------

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

  createWindow()

  // Auto-start the app's own supervised MCP server on launch — this is what
  // the tray (D1.3) and the settings window's status panel reflect. Note
  // this is a SEPARATE process from whatever Claude Desktop spawns via its
  // own config (D1.4): MCP's stdio transport is a 1:1 parent/child pipe, so
  // a single running server process can't be shared between two unrelated
  // parents. If provider=plaid but credentials/passphrase aren't ready yet,
  // start() reports 'crashed' with a clear lastError instead of throwing —
  // surfaced in the status panel, not a startup crash.
  void mcpManager.start()

  // Pending-approvals can change from agent activity alone, independent of
  // MCP process state — refresh periodically so the tray/status panel don't
  // go stale between state-change-triggered pushes.
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
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
