/**
 * S0.4 spike — MCP server lifecycle from the Electron main process.
 *
 * Spawns `@clad/mcp-server`'s `dist/server.js` the same way
 * `packages/cli/src/commands/start.ts` / `serve.ts` do (config-derived env
 * vars, stdio transport), then does a REAL MCP handshake against it using
 * `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`: connect,
 * `tools/list`, and one read-only `tools/call`.
 *
 * Two deliberate deviations from the CLI's `getServerPath()`:
 *
 *  1. Path resolution: the CLI locates the server via a relative
 *     `../../../mcp-server/dist/server.js` walk from its own package
 *     directory. That assumption breaks once packaged — `packages/desktop`
 *     and `packages/mcp-server` don't sit at fixed relative paths inside
 *     `app.asar`. Instead, `@clad/mcp-server` is a normal `dependencies`
 *     entry of `@clad/desktop`, and its entry point is resolved via Node
 *     module resolution (`require.resolve('@clad/mcp-server')`), so
 *     electron-builder's ordinary node_modules bundling carries it into the
 *     packaged app for free.
 *  2. Interpreter: the child is spawned as `process.execPath` (the Electron
 *     binary itself) with `ELECTRON_RUN_AS_NODE=1`, not a system `node`. The
 *     packaged app cannot assume the end user has Node installed — Electron
 *     bundles its own, and this is the documented way to reuse it for a
 *     plain-Node child process.
 */

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { getCladCore } from '../lib/clad-core.js'
import type { McpHandshakeSpikeResult } from '../../shared/ipc.js'

/** Agent id the spike calls under — must match an entry in the temp policy below. */
const SPIKE_AGENT_ID = 'desktop-spike-agent'

const SPIKE_POLICY_YAML = `
agents:
  ${SPIKE_AGENT_ID}:
    description: S0.4 spike — read-only balance check against the dummy provider
    permissions:
      accounts:
        visible:
          - acc_checking_001
          - acc_savings_001
          - acc_credit_001
        balance: true
        account_number: false
        routing_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 30
      audit:
        log_all_queries: true
        log_policy_evaluations: true
        retention: 90d

global:
  max_total_daily_spend: 10000
  max_concurrent_agents: 5
  require_human_approval_above: 1000
  default_escalation_timeout: 300
`

function resolveServerEntry(): string {
  const require = createRequire(import.meta.url)
  // Resolves through @clad/mcp-server's package.json "main" field
  // (./dist/server.js) via ordinary node_modules resolution — works
  // identically in dev (pnpm workspace symlink) and packaged (asar) since
  // Electron's fs layer reads asar-archived files transparently.
  return require.resolve('@clad/mcp-server')
}

let activeTransport: StdioClientTransport | null = null
let activeClient: Client | null = null
let tempDir: string | null = null

export async function runMcpHandshakeSpike(): Promise<McpHandshakeSpikeResult> {
  const serverEntry = resolveServerEntry()

  tempDir = mkdtempSync(join(tmpdir(), 'clad-desktop-mcp-spike-'))
  const policyPath = join(tempDir, 'policy.yaml')
  const auditDbPath = join(tempDir, 'audit.sqlite')
  const approvalDbPath = join(tempDir, 'approvals.sqlite')
  writeFileSync(policyPath, SPIKE_POLICY_YAML, 'utf-8')

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAD_PROVIDER: 'dummy',
    CLAD_POLICY_PATH: policyPath,
    CLAD_AUDIT_DB: auditDbPath,
    CLAD_APPROVAL_DB: approvalDbPath,
    CLAD_AGENT_ID_ARG: SPIKE_AGENT_ID,
    // Run the Electron binary itself as a plain Node process — see module
    // doc comment. Without this, `process.execPath` would launch a second
    // full Electron app instance instead of executing server.js as a script.
    ELECTRON_RUN_AS_NODE: '1',
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env,
    stderr: 'pipe',
  })
  activeTransport = transport

  let stderrBuf = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })

  const client = new Client({ name: 'clad-desktop-spike-client', version: '0.1.0' }, { capabilities: {} })
  activeClient = client

  try {
    await client.connect(transport)

    const { tools } = await client.listTools()
    const toolNames = tools.map((t) => t.name)

    const readOnlyTool = tools.find((t) => t.name === 'clad_get_balances')?.name ?? toolNames[0]

    let calledToolResultPreview: string | undefined
    if (readOnlyTool) {
      const callResult = await client.callTool({ name: readOnlyTool, arguments: {} })
      const content = Array.isArray(callResult.content) ? callResult.content : []
      const firstText = content.find(
        (c): c is { type: 'text'; text: string } => c.type === 'text'
      )
      calledToolResultPreview = firstText ? firstText.text.slice(0, 200) : undefined
    }

    return {
      ok: true,
      tools: toolNames,
      calledTool: readOnlyTool,
      calledToolResultPreview,
      pid: transport.pid ?? undefined,
    }
  } catch (err) {
    const { redactSecrets } = await getCladCore()
    return {
      ok: false,
      tools: [],
      error: redactSecrets(`${err instanceof Error ? err.message : String(err)} | stderr: ${stderrBuf.slice(-500)}`),
    }
  }
}

/**
 * Cleanly tears down the spawned MCP server child. Must be called from
 * `before-quit` so no orphaned `server.js` process survives the app
 * (desktop-app.md S0.4 acceptance: "server child dies when the app quits").
 */
export async function stopMcpHandshakeSpike(): Promise<void> {
  const pid = activeTransport?.pid
  try {
    await activeClient?.close()
  } catch {
    // best-effort
  }
  try {
    await activeTransport?.close()
  } catch {
    // best-effort
  }
  activeClient = null
  activeTransport = null
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
  if (pid) {
    process.stderr.write(`[clad-desktop spike] mcp server child (pid ${pid}) closed\n`)
  }
}
