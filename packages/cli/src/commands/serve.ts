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

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadConfig } from '../config.js'

function getServerPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  // packages/cli/dist/commands/ -> packages/mcp-server/dist/server.js
  const candidate = resolve(__dirname, '../../../mcp-server/dist/server.js')
  if (existsSync(candidate)) return candidate
  return 'clad-server'
}

export function serveCommand(): void {
  const config = loadConfig()
  const serverPath = getServerPath()

  const env = {
    ...process.env,
    CLAD_POLICY_PATH: config.policy_path,
    CLAD_AUDIT_DB: config.audit_db,
    CLAD_APPROVAL_DB: config.approval_db,
  }

  const child = spawn(process.execPath, [serverPath], {
    stdio: 'inherit',
    env,
  })

  child.on('error', (err) => {
    process.stderr.write(`clad serve: failed to start server: ${err.message}\n`)
    process.exit(1)
  })

  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}
