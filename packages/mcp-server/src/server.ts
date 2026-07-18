/**
 * Clad MCP server entry point.
 *
 * Selects its transport from `CLAD_MCP_TRANSPORT`:
 *   - `stdio` (default): the original single-client stdio path used by the
 *     CLI (`clad serve`) and any MCP client that spawns the server directly.
 *     Unchanged behaviour — this is what the `dummy`/local-dev flow relies on.
 *   - `http`: a loopback Streamable HTTP server (`http-transport.ts`), used by
 *     the desktop app's supervised child so Claude Desktop can reach real
 *     provider data through `mcp-remote` without any secret in a config file.
 *     Port from `CLAD_MCP_HTTP_PORT` (default 8765). See `http-transport.ts`.
 *
 * Both transports share `server-core.ts`'s wiring (tool dispatch, policy,
 * provider, audit) — the only difference is which `Transport` gets connected.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  loadServerResources,
  createConfiguredServer,
  writeRedactedStderr,
} from './server-core.js'
import { startHttpServer, resolveMcpHttpPort } from './http-transport.js'

// Re-exported so existing tests can import it from this module unchanged.
export { handleToolCall } from './server-core.js'

async function main() {
  process.stderr.write(`[clad server] starting (PID ${process.pid})\n`)

  const resources = await loadServerResources()

  const transportMode = process.env.CLAD_MCP_TRANSPORT ?? 'stdio'

  if (transportMode === 'http') {
    const port = resolveMcpHttpPort()
    await startHttpServer(resources, { port })
    process.stderr.write(`[clad server] MCP server ready (http)\n`)
    // The HTTP server keeps the event loop alive; nothing else to do here.
    return
  }

  if (transportMode !== 'stdio') {
    throw new Error(
      `[clad server] Unknown CLAD_MCP_TRANSPORT "${transportMode}". Expected "stdio" or "http".`
    )
  }

  const server = createConfiguredServer(resources)
  const transport = new StdioServerTransport()
  process.stderr.write(`[clad server] connecting stdio transport\n`)
  await server.connect(transport)
  process.stderr.write(`[clad server] MCP server ready\n`)
}

main().catch((err) => {
  writeRedactedStderr(`[clad server] fatal: ${err}\n`)
  process.exit(1)
})
