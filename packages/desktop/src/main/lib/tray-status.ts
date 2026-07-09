/**
 * Pure status -> text formatting for the D1.3 tray (menu-bar) icon's
 * tooltip and context-menu labels. Split out from the actual `Tray`/`Menu`
 * construction in `index.ts` (which needs the real `electron` module, and so
 * — like `createWindow` — isn't unit-testable under plain Vitest) so the
 * status -> text mapping itself stays covered by a fast, electron-free test.
 *
 * Takes the same merged `McpServerStatus` (process state + live pending-
 * approvals count) that `ServerStatusPanel.tsx` renders in the settings
 * window, so the tray and the window never disagree about what "running"
 * or "3 pending approvals" means.
 */

import type { McpServerStatus } from '../../shared/ipc.js'

const STATE_LABEL: Record<McpServerStatus['state'], string> = {
  running: 'Running',
  starting: 'Starting…',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  crashed: 'Crashed',
}

export function trayServerStateLabel(state: McpServerStatus['state']): string {
  return STATE_LABEL[state]
}

export function trayApprovalsLabel(pendingApprovals: number): string {
  return pendingApprovals > 0
    ? `${pendingApprovals} pending approval${pendingApprovals === 1 ? '' : 's'}`
    : 'No pending approvals'
}

/** The tray icon's hover tooltip — one line summarizing both server state and approvals. */
export function trayTooltip(status: McpServerStatus): string {
  return `Clad — MCP server: ${trayServerStateLabel(status.state)} · ${trayApprovalsLabel(status.pendingApprovals)}`
}

/** Disabled (label-only) context-menu line for server state. */
export function trayServerStatusMenuLabel(status: McpServerStatus): string {
  return `MCP server: ${trayServerStateLabel(status.state)}`
}

/** Disabled (label-only) context-menu line for pending approvals. */
export function trayApprovalsMenuLabel(status: McpServerStatus): string {
  return trayApprovalsLabel(status.pendingApprovals)
}

/**
 * D1 manual QA finding 4: macOS's NSMenu can't repaint its contents while
 * open (accepted platform limitation — the context menu's labels above only
 * refresh the next time it's opened). The tray icon and tooltip don't have
 * that limitation — both can change while the menu is closed or even open —
 * so they're the one place a status change (most importantly: a crash)
 * becomes visible without the user having to click the tray icon first.
 * `'alert'` is reserved for `crashed` specifically: the one state where
 * something has gone wrong and needs the user's attention, as opposed to the
 * normal starting/stopping/stopped/running lifecycle.
 */
export type TrayIconVariant = 'default' | 'alert'

export function trayIconVariantForStatus(status: McpServerStatus): TrayIconVariant {
  return status.state === 'crashed' ? 'alert' : 'default'
}
