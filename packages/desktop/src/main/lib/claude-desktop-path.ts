/**
 * Resolves Claude Desktop's own config file location — the per-platform
 * lookup module required by desktop-app.md's "Windows portability from day
 * one" rule ("No hardcoded ~/Library outside that module").
 *
 * Takes Electron's own `appData` directory (`app.getPath('appData')`) as a
 * parameter rather than importing `electron` directly, so this stays pure
 * and unit-testable without booting Electron (same DI shape as
 * `sealed-file.ts`/`passphrase.ts`) — the D1.4 testing constraint is
 * explicit that tests must never touch the real Claude Desktop config, only
 * a pure path computation against a fake directory.
 *
 * There is deliberately no `if (platform === 'darwin') ... else ...` branch
 * here: `app.getPath('appData')` already resolves to the right per-platform
 * base directory —
 *   - macOS:   ~/Library/Application Support
 *   - Windows: %APPDATA% (i.e. ...\AppData\Roaming)
 *   - Linux:   $XDG_CONFIG_HOME or ~/.config
 * — and Claude Desktop's install layout on every platform it ships for is
 * exactly `<that directory>/Claude/claude_desktop_config.json`. So the
 * platform-specific part of this "per-platform path lookup" is entirely
 * Electron's job; this module just appends the fixed `Claude/...` suffix.
 */

import { join } from 'node:path'

const CLAUDE_DIR_NAME = 'Claude'
const CONFIG_FILE_NAME = 'claude_desktop_config.json'

/** The directory Claude Desktop creates on first launch (holds its config, logs, etc.). */
export function claudeDesktopDir(appDataDir: string): string {
  return join(appDataDir, CLAUDE_DIR_NAME)
}

/** Full path to `claude_desktop_config.json`, whether or not it (or its parent directory) exists yet. */
export function claudeDesktopConfigPath(appDataDir: string): string {
  return join(claudeDesktopDir(appDataDir), CONFIG_FILE_NAME)
}
