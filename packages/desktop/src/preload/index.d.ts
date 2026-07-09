import type { CladBridge } from '../shared/ipc'

declare global {
  interface Window {
    clad: CladBridge
  }
}
