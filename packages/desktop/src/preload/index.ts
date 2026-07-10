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
  type ApprovalsListInput,
  type ApprovalDecisionInput,
  type ApprovalFocusRequest,
  type AuditLogQueryInput,
  type StartPlaidLinkInput,
  type PlaidLinkFlowStatus,
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
  listApprovals: (input?: ApprovalsListInput) => ipcRenderer.invoke(IPC_CHANNELS.approvalsList, input),
  decideApproval: (input: ApprovalDecisionInput) => ipcRenderer.invoke(IPC_CHANNELS.approvalsDecide, input),
  onApprovalFocusRequested: (callback: (request: ApprovalFocusRequest) => void) => {
    const listener = (_event: IpcRendererEvent, request: ApprovalFocusRequest): void => callback(request)
    ipcRenderer.on(IPC_CHANNELS.approvalFocusRequested, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.approvalFocusRequested, listener)
  },
  queryAuditLog: (input: AuditLogQueryInput) => ipcRenderer.invoke(IPC_CHANNELS.auditLogQuery, input),
  getConnectProvidersStatus: () => ipcRenderer.invoke(IPC_CHANNELS.connectGetProvidersStatus),
  startPlaidLink: (input?: StartPlaidLinkInput) => ipcRenderer.invoke(IPC_CHANNELS.plaidLinkStart, input),
  cancelPlaidLink: () => ipcRenderer.invoke(IPC_CHANNELS.plaidLinkCancel),
  getPlaidLinkStatus: () => ipcRenderer.invoke(IPC_CHANNELS.plaidLinkGetStatus),
  onPlaidLinkStatusChanged: (callback: (status: PlaidLinkFlowStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: PlaidLinkFlowStatus): void => callback(status)
    ipcRenderer.on(IPC_CHANNELS.plaidLinkStatusChanged, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.plaidLinkStatusChanged, listener)
  },
  connectSimpleFin: (setupToken: string) => ipcRenderer.invoke(IPC_CHANNELS.simplefinConnect, setupToken),
  listPlaidItems: () => ipcRenderer.invoke(IPC_CHANNELS.connectListPlaidItems),
  removePlaidItem: (itemId: string) => ipcRenderer.invoke(IPC_CHANNELS.connectRemovePlaidItem, itemId),
  listSimpleFinItems: () => ipcRenderer.invoke(IPC_CHANNELS.connectListSimpleFinItems),
  removeSimpleFinItem: (itemId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.connectRemoveSimpleFinItem, itemId),
}

contextBridge.exposeInMainWorld('clad', cladBridge)
