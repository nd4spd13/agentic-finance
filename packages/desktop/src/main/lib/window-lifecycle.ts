/**
 * Pure decision logic for the `window-all-closed` app event — split out of
 * `index.ts` (same testability rationale as `tray-status.ts`: no `electron`
 * import, so this is unit-testable under plain Vitest without a live
 * Electron process).
 *
 * Bug this fixes (D1 manual QA finding 1): the original handler was stock
 * Electron boilerplate, `if (process.platform !== 'darwin') app.quit()`,
 * which keys quitting on the OS rather than on the user's `close_to_tray`
 * setting. On macOS that meant `window-all-closed` never quit the app at
 * all — with `close_to_tray` turned off in Settings, closing the window
 * closed the window but left the app, tray, and supervised MCP server child
 * running forever, with no way to quit short of a force-kill.
 *
 * `window-all-closed` only fires here in two cases: (1) the window's `close`
 * handler in `index.ts` let the close proceed (didn't call
 * `preventDefault()`) because `close_to_tray` is `false` — the common case
 * this fix addresses; or (2) a window was destroyed programmatically without
 * going through that handler. A real app quit (tray's "Quit Clad", Cmd+Q's
 * default handling, `before-quit`) never reaches this at all —
 * `before-quit` -> `app.exit(0)` in `index.ts` terminates the process
 * directly without ever dispatching `window-all-closed`. Either way the
 * right rule is the same: quit exactly when `close_to_tray` is off. If it's
 * on and this fires anyway (case 2), NOT quitting is still correct — the
 * tray is supposed to keep the app alive regardless of platform or how the
 * window went away.
 */
export function shouldQuitOnAllWindowsClosed(config: { close_to_tray: boolean }): boolean {
  return !config.close_to_tray
}
