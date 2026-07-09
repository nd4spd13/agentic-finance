import { describe, it, expect } from 'vitest'
import { shouldQuitOnAllWindowsClosed } from '../src/main/lib/window-lifecycle.js'

/**
 * Regression test for D1 manual QA finding 1: `window-all-closed` used to
 * key quitting off `process.platform` instead of the user's `close_to_tray`
 * setting, so on macOS the app/tray/MCP server child never quit even with
 * `close_to_tray: false`. See `window-lifecycle.ts`'s module doc for the
 * full analysis.
 */
describe('shouldQuitOnAllWindowsClosed', () => {
  it('quits when close_to_tray is off, regardless of platform', () => {
    expect(shouldQuitOnAllWindowsClosed({ close_to_tray: false })).toBe(true)
  })

  it('does not quit when close_to_tray is on — the tray keeps the app alive', () => {
    expect(shouldQuitOnAllWindowsClosed({ close_to_tray: true })).toBe(false)
  })
})
