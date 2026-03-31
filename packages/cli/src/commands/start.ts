/**
 * clad start — launch the Clad MCP server
 * Spawns the MCP server process with config-derived env vars
 */

import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { loadConfig } from '../config.js'

function getServerPath(): string {
  // Resolve server relative to this package
  const __dirname = dirname(fileURLToPath(import.meta.url))
  // packages/cli/dist/commands/ -> packages/mcp-server/dist/server.js
  const candidate = resolve(__dirname, '../../../mcp-server/dist/server.js')
  if (existsSync(candidate)) return candidate

  // Fallback: look for clad-server in PATH
  return 'clad-server'
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function startCommand(opts: { foreground?: boolean } = {}): void {
  const config = loadConfig()

  // Check if already running
  if (existsSync(config.server_pid_file)) {
    const pidStr = readFileSync(config.server_pid_file, 'utf-8').trim()
    const pid = parseInt(pidStr, 10)
    if (!isNaN(pid) && isRunning(pid)) {
      console.log(`Clad is already running (PID ${pid})`)
      return
    }
  }

  const serverPath = getServerPath()

  const env = {
    ...process.env,
    CLAD_POLICY_PATH: config.policy_path,
    CLAD_AUDIT_DB: config.audit_db,
    CLAD_APPROVAL_DB: config.approval_db,
  }

  if (opts.foreground) {
    // Foreground mode (for MCP stdio transport — Claude Desktop uses this)
    console.log(`Starting Clad MCP server (foreground)...`)
    console.log(`  Policy:  ${config.policy_path}`)
    console.log(`  Audit:   ${config.audit_db}`)
    console.log(`  Approvals: ${config.approval_db}`)

    const child = spawn(process.execPath, [serverPath], {
      stdio: 'inherit',
      env,
    })

    child.on('exit', (code) => {
      process.exit(code ?? 0)
    })
  } else {
    // Background mode (daemon)
    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: 'ignore',
      env,
    })

    child.unref()

    if (child.pid) {
      writeFileSync(config.server_pid_file, String(child.pid), 'utf-8')
      console.log(`✓ Clad started (PID ${child.pid})`)
      console.log(`  Policy:  ${config.policy_path}`)
      console.log(`  Audit:   ${config.audit_db}`)
    } else {
      console.error('Failed to start server')
      process.exit(1)
    }
  }
}

export function stopCommand(): void {
  const config = loadConfig()

  if (!existsSync(config.server_pid_file)) {
    console.log('Server is not running (no PID file found)')
    return
  }

  const pidStr = readFileSync(config.server_pid_file, 'utf-8').trim()
  const pid = parseInt(pidStr, 10)

  if (isNaN(pid)) {
    console.error('Invalid PID file')
    return
  }

  if (!isRunning(pid)) {
    console.log('Server is not running')
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
    console.log(`✓ Clad stopped (PID ${pid})`)
  } catch (err) {
    console.error(`Failed to stop server: ${err}`)
  }
}
