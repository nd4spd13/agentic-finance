/**
 * Clad desktop app — Electron main process entry point.
 *
 * Spike S0 scaffold: on startup, runs the three main-process spikes
 * (S0.2 node:sqlite, S0.3 safeStorage passphrase custody, S0.4 MCP server
 * lifecycle + handshake) and exposes only their display-safe results to the
 * renderer over the typed IPC contract in `../shared/ipc.js`.
 *
 * Security posture (desktop-app.md, non-negotiable):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true.
 *  - All secret material (passphrase, tokens, DB handles) stays in this
 *    process. Only `SpikeStatus` (booleans/strings/paths) crosses IPC.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { runNodeSqliteSpike } from './spike/node-sqlite-check.js'
import { runPassphraseCustodySpike } from './spike/passphrase-custody.js'
import { runMcpHandshakeSpike, stopMcpHandshakeSpike } from './spike/mcp-handshake.js'
import { IPC_CHANNELS, type SpikeStatus } from '../shared/ipc.js'

// `__dirname` (ambient via @types/node) is a CommonJS global — valid here
// because electron-vite's default main-process build output is CJS (see
// electron.vite.config.ts).

let spikeStatus: SpikeStatus | null = null
let mainWindow: BrowserWindow | null = null

async function runAllSpikes(): Promise<SpikeStatus> {
  // S0.3 first: the passphrase it produces is what a real token-store open
  // would use. The S0.2 spike still exercises SqliteTokenStore with its own
  // fixed test passphrase per the plan, independent of custody.
  const { result: s03PassphraseCustody } = await runPassphraseCustodySpike()
  const s02NodeSqlite = await runNodeSqliteSpike()
  const s04McpHandshake = await runMcpHandshakeSpike()

  const status: SpikeStatus = { s02NodeSqlite, s03PassphraseCustody, s04McpHandshake }

  // Non-secret status line only — no token/passphrase material here.
  process.stderr.write(`[clad-desktop] spike results: ${JSON.stringify(status)}\n`)

  return status
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

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle(IPC_CHANNELS.getSpikeStatus, () => spikeStatus)

app.whenReady().then(async () => {
  spikeStatus = await runAllSpikes()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
  await stopMcpHandshakeSpike()
  app.exit(0)
})

// Electron does not wire OS termination signals to `app.quit()` on its own
// (SIGTERM/SIGINT would otherwise kill the process abruptly, leaving the
// spawned MCP server child orphaned). Route them through the same
// before-quit cleanup path so `pkill`/process-manager stop and Ctrl-C in a
// terminal both shut the child down cleanly — verified for S0.4 via `ps`.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.quit()
  })
}
