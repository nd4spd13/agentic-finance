/**
 * clad serve — start the MCP server for stdio transport
 *
 * Designed for use by MCP clients (Claude Desktop, OpenAI, etc.) that
 * launch clad as a subprocess and communicate over stdio JSON-RPC.
 *
 * IMPORTANT: this command must produce zero output on stdout before the
 * server process takes over. Any stray bytes corrupt the MCP protocol.
 * Diagnostic output goes to stderr only.
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadConfig, ensureConfigDir } from '../config.js'

function getServerPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  // packages/cli/dist/commands/ -> packages/mcp-server/dist/server.js
  const candidate = resolve(__dirname, '../../../mcp-server/dist/server.js')
  if (existsSync(candidate)) return candidate
  return 'clad-server'
}

export function serveCommand(opts: { agentId?: string } = {}): void {
  const config = loadConfig()
  const serverPath = getServerPath()

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAD_POLICY_PATH: config.policy_path,
    CLAD_AUDIT_DB: config.audit_db,
    CLAD_APPROVAL_DB: config.approval_db,
    CLAD_PROVIDER: config.provider,
    CLAD_PLAID_DB: config.plaid_db,
    CLAD_SIMPLEFIN_DB: config.simplefin_db,
  }

  // CLI flag takes precedence over CLAD_AGENT_ID env var
  if (opts.agentId) {
    env.CLAD_AGENT_ID_ARG = opts.agentId
  }

  const child = spawn(process.execPath, [serverPath], {
    stdio: 'inherit',
    env,
  })

  ensureConfigDir()
  process.stderr.write(`[clad serve] writing PID ${child.pid} to ${config.server_pid_file}\n`)
  writeFileSync(config.server_pid_file, String(child.pid), 'utf-8')

  const cleanup = () => {
    process.stderr.write(`[clad serve] cleaning up PID file ${config.server_pid_file}\n`)
    try { unlinkSync(config.server_pid_file) } catch { /* already gone */ }
  }

  child.on('error', (err) => {
    cleanup()
    process.stderr.write(`clad serve: failed to start server: ${err.message}\n`)
    process.exit(1)
  })

  child.on('exit', (code) => {
    cleanup()
    process.exit(code ?? 0)
  })
}
