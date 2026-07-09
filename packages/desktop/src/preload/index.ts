/**
 * Preload script — the only bridge between the sandboxed renderer and the
 * main process. Exposes exactly the `CladBridge` shape from
 * `../shared/ipc.ts` via `contextBridge`; no raw `ipcRenderer` reference
 * (and no other channel) ever reaches the renderer's `window`.
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type CladBridge,
  type SetProviderAndEnvInput,
  type SetPlaidCredentialsInput,
} from '../shared/ipc.js'

const cladBridge: CladBridge = {
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.configGet),
  setProviderAndEnv: (input: SetProviderAndEnvInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.configSetProviderAndEnv, input),
  hasPlaidCredentials: () => ipcRenderer.invoke(IPC_CHANNELS.plaidCredentialsHas),
  setPlaidCredentials: (input: SetPlaidCredentialsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.plaidCredentialsSet, input),
  clearPlaidCredentials: () => ipcRenderer.invoke(IPC_CHANNELS.plaidCredentialsClear),
  getMigrationStatus: () => ipcRenderer.invoke(IPC_CHANNELS.migrationGetStatus),
  submitCliPassphrase: (passphrase: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.migrationSubmitCliPassphrase, passphrase),
  startFreshTokenStore: () => ipcRenderer.invoke(IPC_CHANNELS.migrationStartFresh),
}

contextBridge.exposeInMainWorld('clad', cladBridge)
