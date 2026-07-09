/**
 * Clad desktop app — Electron main process entry point.
 *
 * D1.1: config bootstrap, safeStorage passphrase custody (with the CLI
 * migration flow), and Plaid credential storage, all wired over the typed
 * IPC contract in `../shared/ipc.js`. D1.2 (MCP lifecycle), D1.3
 * (tray/menu-bar), and D1.4 (Connect to Claude Desktop) extend this file in
 * later commits.
 *
 * Security posture (desktop-app.md, non-negotiable):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true.
 *  - All secret material (passphrase, Plaid credentials, tokens, DB
 *    handles) stays in this process. Only display-safe view models
 *    (`DisplayConfig`, `MigrationStatus`, `OperationResult`) cross IPC.
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
import {
  IPC_CHANNELS,
  type DisplayConfig,
  type SetProviderAndEnvInput,
  type SetPlaidCredentialsInput,
  type OperationResult,
  type MigrationStatus,
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

// Electron does not wire OS termination signals to `app.quit()` on its own.
// Route them through the normal quit path so `pkill`/process-manager stop
// and Ctrl-C in a terminal both shut the app down cleanly. (D1.2 adds
// MCP-child cleanup to a `before-quit` handler here.)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.quit()
  })
}
