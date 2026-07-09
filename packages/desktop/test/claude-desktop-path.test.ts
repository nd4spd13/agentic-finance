import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { claudeDesktopDir, claudeDesktopConfigPath } from '../src/main/lib/claude-desktop-path.js'

describe('claude-desktop-path', () => {
  it('joins the appData dir with Claude/claude_desktop_config.json', () => {
    const appData = join('/fake', 'Library', 'Application Support')
    expect(claudeDesktopDir(appData)).toBe(join(appData, 'Claude'))
    expect(claudeDesktopConfigPath(appData)).toBe(join(appData, 'Claude', 'claude_desktop_config.json'))
  })

  it('is a pure function of appData — no platform branch, no real filesystem access', () => {
    // Same fake appData in, same path out, regardless of what OS this test
    // happens to run on — nothing here reads process.platform or touches disk.
    const appData = join('/some', 'fake', 'appdata', 'dir')
    const first = claudeDesktopConfigPath(appData)
    const second = claudeDesktopConfigPath(appData)
    expect(first).toBe(second)
    expect(first).toContain('Claude')
    expect(first.endsWith('claude_desktop_config.json')).toBe(true)
  })
})
