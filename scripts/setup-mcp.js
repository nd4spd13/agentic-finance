#!/usr/bin/env node

/**
 * Generates .mcp.json with absolute paths for the current machine.
 *
 * MCP clients (Claude Code, Claude Desktop) spawn server processes with a
 * minimal environment — `node` is usually not in PATH. This script resolves
 * the full path to the running Node binary and the server entry point so
 * the MCP config works reliably.
 *
 * Usage: pnpm mcp:setup
 */

import { writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const serverJs = resolve(projectRoot, 'packages/mcp-server/dist/server.js')
const policyPath = resolve(projectRoot, 'examples/policy.yaml')
const mcpJsonPath = resolve(projectRoot, '.mcp.json')

if (!existsSync(serverJs)) {
  console.error('Error: packages/mcp-server/dist/server.js not found.')
  console.error('Run `pnpm build` first.')
  process.exit(1)
}

const config = {
  mcpServers: {
    clad: {
      command: process.execPath,
      args: [serverJs],
      env: {
        CLAD_AGENT_ID: 'finance-agent',
        CLAD_POLICY_PATH: policyPath,
        CLAD_AUDIT_DB: resolve(projectRoot, '.clad/audit.sqlite'),
        CLAD_APPROVAL_DB: resolve(projectRoot, '.clad/approvals.sqlite'),
      },
    },
  },
}

writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n')

console.log('✓ .mcp.json generated')
console.log(`  node:   ${process.execPath}`)
console.log(`  server: ${serverJs}`)
console.log(`  policy: ${policyPath}`)
console.log('')
console.log('Restart Claude Code to activate the Clad MCP.')
