/**
 * Preload script — the only bridge between the sandboxed renderer and the
 * main process. Exposes exactly the `CladBridge` shape from
 * `../shared/ipc.ts` via `contextBridge`; no raw `ipcRenderer` reference
 * (and no other channel) ever reaches the renderer's `window`.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type CladBridge,
  type SetProviderAndEnvInput,
  type SetCloseToTrayInput,
  type SetPlaidCredentialsInput,
  type McpServerStatus,
  type PolicyDoc,
} from '../shared/ipc.js'

const cladBridge: CladBridge = {
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.configGet),
  setProviderAndEnv: (input: SetProviderAndEnvInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.configSetProviderAndEnv, input),
  setCloseToTray: (input: SetCloseToTrayInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.configSetCloseToTray, input),
  hasPlaidCredentials: () => ipcRenderer.invoke(IPC_CHANNELS.plaidCredentialsHas),
  setPlaidCredentials: (input: SetPlaidCredentialsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.plaidCredentialsSet, input),
  clearPlaidCredentials: () => ipcRenderer.invoke(IPC_CHANNELS.plaidCredentialsClear),
  getMigrationStatus: () => ipcRenderer.invoke(IPC_CHANNELS.migrationGetStatus),
  submitCliPassphrase: (passphrase: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.migrationSubmitCliPassphrase, passphrase),
  startFreshTokenStore: () => ipcRenderer.invoke(IPC_CHANNELS.migrationStartFresh),
  getMcpStatus: () => ipcRenderer.invoke(IPC_CHANNELS.mcpGetStatus),
  startMcpServer: () => ipcRenderer.invoke(IPC_CHANNELS.mcpStart),
  stopMcpServer: () => ipcRenderer.invoke(IPC_CHANNELS.mcpStop),
  restartMcpServer: () => ipcRenderer.invoke(IPC_CHANNELS.mcpRestart),
  onMcpStatusChanged: (callback: (status: McpServerStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: McpServerStatus): void => callback(status)
    ipcRenderer.on(IPC_CHANNELS.mcpStatusChanged, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.mcpStatusChanged, listener)
  },
  getClaudeDesktopConnectPreview: (agentId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.claudeDesktopGetPreview, agentId),
  connectClaudeDesktop: (agentId?: string) => ipcRenderer.invoke(IPC_CHANNELS.claudeDesktopConnect, agentId),
  getDashboardSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.dashboardGetSnapshot),
  refreshDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.dashboardRefresh),
  getPolicy: () => ipcRenderer.invoke(IPC_CHANNELS.policyGet),
  setPolicy: (policy: PolicyDoc) => ipcRenderer.invoke(IPC_CHANNELS.policySet, policy),
}

contextBridge.exposeInMainWorld('clad', cladBridge)
