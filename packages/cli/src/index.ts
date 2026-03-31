#!/usr/bin/env node
/**
 * Clad CLI — CRS-30 + CRS-29
 * Financial permissions middleware for AI agents
 */

import { Command } from 'commander'
import { initCommand } from './commands/init.js'
import { startCommand, stopCommand } from './commands/start.js'
import { statusCommand } from './commands/status.js'
import { policyValidateCommand, policyShowCommand } from './commands/policy.js'
import { logCommand, logExportCommand } from './commands/log.js'
import {
  approvalsListCommand,
  approveCommand,
  denyCommand,
  lockdownCommand,
} from './commands/approvals.js'

const program = new Command()

program
  .name('clad')
  .description('Clad — financial permissions middleware for AI agents')
  .version('0.1.0')

// ── clad init ────────────────────────────────────────────────────────────
program
  .command('init')
  .description('First-time setup: create config and starter policy')
  .action(async () => {
    await initCommand()
  })

// ── clad start ───────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the Clad MCP server')
  .option('-f, --foreground', 'Run in foreground (stdio mode for Claude Desktop)')
  .action((opts: { foreground?: boolean }) => {
    startCommand({ foreground: opts.foreground })
  })

// ── clad stop ────────────────────────────────────────────────────────────
program
  .command('stop')
  .description('Stop the background Clad server')
  .action(() => {
    stopCommand()
  })

// ── clad status ──────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show server status, policy health, and pending approvals')
  .action(async () => {
    await statusCommand()
  })

// ── clad policy ──────────────────────────────────────────────────────────
const policyCmd = program
  .command('policy')
  .description('Policy management commands')

policyCmd
  .command('validate [path]')
  .description('Validate a policy YAML file')
  .action(async (path?: string) => {
    await policyValidateCommand(path)
  })

policyCmd
  .command('show [path]')
  .description('Display the parsed policy as JSON')
  .action(async (path?: string) => {
    await policyShowCommand(path)
  })

// ── clad log ─────────────────────────────────────────────────────────────
const logCmd = program
  .command('log')
  .description('View the audit log')
  .option('-a, --agent <id>', 'Filter by agent ID')
  .option('-d, --decision <decision>', 'Filter by decision (allow|deny|escalate)')
  .option('-t, --tool <name>', 'Filter by tool name')
  .option('--since <date>', 'Show records since date (ISO 8601)')
  .option('--until <date>', 'Show records until date (ISO 8601)')
  .option('-n, --limit <n>', 'Show last N records', (v: string) => parseInt(v, 10))
  .option('--json', 'Output as JSON')
  .action((opts) => {
    logCommand(opts)
  })

logCmd
  .command('export <file>')
  .description('Export audit log to JSON or CSV (detected by file extension)')
  .option('-a, --agent <id>', 'Filter by agent ID')
  .option('-d, --decision <decision>', 'Filter by decision')
  .action((file: string, opts) => {
    logExportCommand(file, opts)
  })

// ── clad approvals ───────────────────────────────────────────────────────
program
  .command('approvals')
  .description('List pending approval requests (HITL queue)')
  .option('--all', 'Show all approvals, not just pending')
  .option('-a, --agent <id>', 'Filter by agent ID')
  .action((opts: { all?: boolean; agent?: string }) => {
    approvalsListCommand(opts)
  })

// ── clad approve <id> ────────────────────────────────────────────────────
program
  .command('approve <id>')
  .description('Approve a pending escalation request')
  .action((id: string) => {
    approveCommand(id)
  })

// ── clad deny <id> ───────────────────────────────────────────────────────
program
  .command('deny <id>')
  .description('Deny a pending escalation request')
  .action((id: string) => {
    denyCommand(id)
  })

// ── clad lockdown ────────────────────────────────────────────────────────
program
  .command('lockdown')
  .description('Immediately deny all pending approvals')
  .action(() => {
    lockdownCommand()
  })

program.parseAsync(process.argv).catch((err) => {
  console.error(err)
  process.exit(1)
})
