/**
 * Preload script — the only bridge between the sandboxed renderer and the
 * main process. Exposes exactly the `CladBridge` shape from
 * `../shared/ipc.ts` via `contextBridge`; no raw `ipcRenderer` reference
 * (and no other channel) ever reaches the renderer's `window`.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type CladBridge } from '../shared/ipc.js'

const cladBridge: CladBridge = {
  getSpikeStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getSpikeStatus),
}

contextBridge.exposeInMainWorld('clad', cladBridge)
