#!/usr/bin/env node

/**
 * Generates .mcp.json with absolute paths for the current machine.
 *
 * MCP clients (Claude Code, Claude Desktop) spawn server processes with a
 * minimal environment where `node` is usually not in PATH. This script
 * resolves the full path to the running Node binary and the server entry
 * point so the MCP config works reliably.
 *
 * Writes to:
 *   1. <project-root>/.mcp.json  — project-level (Claude Code auto-detects)
 *   2. ~/.claude/mcp.json        — user-level (works across all projects)
 *
 * Usage: pnpm mcp:setup
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const serverJs = resolve(projectRoot, 'packages/mcp-server/dist/server.js')
const policyPath = resolve(projectRoot, 'examples/policy.yaml')

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

const configJson = JSON.stringify(config, null, 2) + '\n'

// 1. Write to project root
const projectMcpJson = resolve(projectRoot, '.mcp.json')
writeFileSync(projectMcpJson, configJson)

// 2. Write to user-level Claude Code config
const claudeDir = resolve(homedir(), '.claude')
if (!existsSync(claudeDir)) {
  mkdirSync(claudeDir, { recursive: true })
}
const userMcpJson = resolve(claudeDir, 'mcp.json')
writeFileSync(userMcpJson, configJson)

console.log('✓ .mcp.json generated')
console.log(`  node:     ${process.execPath}`)
console.log(`  server:   ${serverJs}`)
console.log(`  policy:   ${policyPath}`)
console.log('')
console.log(`  Written to:`)
console.log(`    ${projectMcpJson}`)
console.log(`    ${userMcpJson}`)
console.log('')
console.log('Restart Claude Code to activate the Clad MCP.')
