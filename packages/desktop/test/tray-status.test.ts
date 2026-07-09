import { describe, it, expect } from 'vitest'
import {
  trayServerStateLabel,
  trayApprovalsLabel,
  trayTooltip,
  trayServerStatusMenuLabel,
  trayApprovalsMenuLabel,
  trayIconVariantForStatus,
} from '../src/main/lib/tray-status.js'
import type { McpServerStatus } from '../src/shared/ipc.js'

function status(overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    state: 'running',
    tools: ['clad_get_balances'],
    restartAttempt: 0,
    pendingApprovals: 0,
    ...overrides,
  }
}

describe('tray-status', () => {
  it('trayServerStateLabel covers every McpServerState', () => {
    expect(trayServerStateLabel('running')).toBe('Running')
    expect(trayServerStateLabel('starting')).toBe('Starting…')
    expect(trayServerStateLabel('stopping')).toBe('Stopping…')
    expect(trayServerStateLabel('stopped')).toBe('Stopped')
    expect(trayServerStateLabel('crashed')).toBe('Crashed')
  })

  it('trayApprovalsLabel singular vs plural vs zero', () => {
    expect(trayApprovalsLabel(0)).toBe('No pending approvals')
    expect(trayApprovalsLabel(1)).toBe('1 pending approval')
    expect(trayApprovalsLabel(2)).toBe('2 pending approvals')
  })

  it('trayTooltip combines server state and approvals into one line', () => {
    expect(trayTooltip(status({ state: 'running', pendingApprovals: 3 }))).toBe(
      'Clad — MCP server: Running · 3 pending approvals'
    )
    expect(trayTooltip(status({ state: 'crashed', pendingApprovals: 0 }))).toBe(
      'Clad — MCP server: Crashed · No pending approvals'
    )
  })

  it('trayServerStatusMenuLabel and trayApprovalsMenuLabel format the disabled menu lines', () => {
    const s = status({ state: 'stopped', pendingApprovals: 5 })
    expect(trayServerStatusMenuLabel(s)).toBe('MCP server: Stopped')
    expect(trayApprovalsMenuLabel(s)).toBe('5 pending approvals')
  })

  /**
   * D1 manual QA finding 4: the tray icon (and tooltip, covered above)
   * update live even though the context menu can't repaint while open
   * (macOS NSMenu limitation, accepted). Only 'crashed' gets the 'alert'
   * icon — it's the one state that actually needs the user's attention.
   */
  it('trayIconVariantForStatus is "alert" only for crashed, "default" for every other state', () => {
    expect(trayIconVariantForStatus(status({ state: 'crashed' }))).toBe('alert')
    expect(trayIconVariantForStatus(status({ state: 'running' }))).toBe('default')
    expect(trayIconVariantForStatus(status({ state: 'starting' }))).toBe('default')
    expect(trayIconVariantForStatus(status({ state: 'stopping' }))).toBe('default')
    expect(trayIconVariantForStatus(status({ state: 'stopped' }))).toBe('default')
  })
})
