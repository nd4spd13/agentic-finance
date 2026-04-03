/**
 * clad start — launch the Clad MCP server
 * Spawns the MCP server process with config-derived env vars
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadConfig, ensureConfigDir } from '../config.js'

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
    // Foreground mode (for MCP stdio transport — Claude Desktop uses this).
    // IMPORTANT: zero bytes to stdout before server connects — any stray output
    // corrupts the MCP JSON-RPC protocol. Diagnostics go to stderr only.
    process.stderr.write(`[clad] starting MCP server (foreground)\n`)
    process.stderr.write(`[clad]   policy:    ${config.policy_path}\n`)
    process.stderr.write(`[clad]   audit:     ${config.audit_db}\n`)
    process.stderr.write(`[clad]   approvals: ${config.approval_db}\n`)

    const child = spawn(process.execPath, [serverPath], {
      stdio: 'inherit',
      env,
    })

    ensureConfigDir()
    process.stderr.write(`[clad start] writing PID ${child.pid} to ${config.server_pid_file}\n`)
    writeFileSync(config.server_pid_file, String(child.pid), 'utf-8')

    const cleanup = () => {
      process.stderr.write(`[clad start] cleaning up PID file ${config.server_pid_file}\n`)
      try { unlinkSync(config.server_pid_file) } catch { /* already gone */ }
    }

    child.on('error', (err) => {
      cleanup()
      process.stderr.write(`clad start: failed to start server: ${err.message}\n`)
      process.exit(1)
    })

    child.on('exit', (code) => {
      process.stderr.write(`[clad start] server exited with code ${code}\n`)
      cleanup()
      process.exit(code ?? 0)
    })
  } else {
    // Background (daemon) mode — requires the MCP server to use a non-stdio
    // transport (e.g. HTTP/SSE). The current server uses StdioServerTransport,
    // which exits immediately when stdin is /dev/null. Use `clad serve` for
    // stdio-based MCP clients, or `clad start --foreground` for a kept-alive
    // foreground process.
    process.stderr.write(
      `[clad] warning: background mode is not supported with the stdio transport.\n` +
      `[clad] use 'clad serve' to start the MCP server for stdio-based clients.\n`
    )

    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: 'ignore',
      env,
    })

    child.unref()

    if (child.pid) {
      ensureConfigDir()
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
