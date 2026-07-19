/**
 * Transport-agnostic server wiring shared by both the stdio entry
 * (`server.ts`) and the loopback HTTP entry (`http-transport.ts`).
 *
 * Factored out so the two transports run IDENTICAL tool-dispatch, policy,
 * audit, and provider logic — the only thing that differs between them is the
 * `Transport` object handed to `Server.connect()`. Everything security-
 * relevant (`handleToolCall`'s redaction, the policy load, provider
 * selection) lives here exactly once.
 *
 * `handleToolCall` is re-exported by `server.ts` so existing test imports
 * (`import { handleToolCall } from '../src/server.js'`) keep working.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { CallToolRequest, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import {
  parsePolicy,
  AuditLogger,
  ApprovalQueue,
  redactSecrets,
  SqliteGrantStore,
  type PolicyConfig,
  type FinancialDataProvider,
} from '@clad/core'
import type { ToolContext, ToolDefinition } from './types.js'
import { createProvider } from './provider-factory.js'
import { CladOAuthProvider } from './oauth/provider.js'

// Import all tool handlers
import * as getBalances from './tools/clad_get_balances.js'
import * as getTransactions from './tools/clad_get_transactions.js'
import * as safeToSpend from './tools/clad_safe_to_spend.js'
import * as requestAction from './tools/clad_request_action.js'
import * as auditLog from './tools/clad_audit_log.js'

export const tools: ToolDefinition[] = [getBalances, getTransactions, safeToSpend, requestAction, auditLog]

/**
 * Writes a diagnostic line to stderr with any error text redacted first.
 * Use this instead of a bare `process.stderr.write` whenever the message
 * embeds an error object or other value that could carry Plaid token or
 * secret material (e.g. axios errors embedding request headers/body).
 * Static literal messages don't need this.
 */
export function writeRedactedStderr(message: string): void {
  process.stderr.write(redactSecrets(message))
}

/**
 * Handles a single `tools/call` request: dispatches to the matching tool
 * handler, records an audit trail entry, and redacts any secret material
 * before it can reach the audit DB, stderr, or the MCP client.
 *
 * Factored out of `main()` so it can be unit-tested without a stdio
 * transport — tests can call this directly with fake deps.
 */
export async function handleToolCall(
  request: CallToolRequest,
  deps: {
    tools: ToolDefinition[]
    agentId: string
    context: Omit<ToolContext, 'agentId'>
    auditLogger: AuditLogger
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { name, arguments: args } = request.params
  const tool = deps.tools.find(t => t.name === name)
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
  }

  const context: ToolContext = { agentId: deps.agentId, ...deps.context }

  try {
    const result = await tool.handler(args ?? {}, context)
    // Log to audit trail (redacted defense in depth — args shouldn't carry
    // secrets, but tool input is untrusted).
    deps.auditLogger.logRequest(deps.agentId, name, 'allow', redactSecrets(JSON.stringify(args)))
    return result
  } catch (error) {
    const redactedError = redactSecrets(String(error))
    deps.auditLogger.logRequest(deps.agentId, name, 'deny', redactedError)
    return { content: [{ type: 'text', text: `Error: ${redactedError}` }] }
  }
}

/**
 * Thrown by {@link resolvePrincipal} when `resources.authRequired` is true but
 * no verified `profileId` was found on the request (`extra.authInfo.extra`).
 *
 * This is defence-in-depth, not the primary gate: on the real (WS2) auth
 * path, `requireBearerAuth` already 401s an unauthenticated request before it
 * reaches a tool-call handler at all. This error exists for the case where
 * that layer is misconfigured or bypassed.
 *
 * The message is a FIXED, secret-free constant — mirrors `TokenStoreKeyError`'s
 * discipline (`@clad/core`'s `security/token-store-errors.ts`): never
 * interpolate a token, header, or env value into this text.
 */
export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED' as const

  constructor() {
    super(
      'Unauthenticated: this request carries no verified agent profile. ' +
        'A valid access token is required.'
    )
    this.name = 'UnauthenticatedError'
  }
}

/**
 * The verified agent-profile principal for THIS request — see WS3 §3
 * (`.claude/plans/d5.3/WS3-resource-enforcement.md`).
 *
 *  - HTTP + `CLAD_MCP_AUTH=oauth` (`resources.authRequired`): MUST come from
 *    `extra.authInfo.extra.profileId` — a verified principal set by the
 *    transport's auth layer (the dev-only static-bearer bridge in
 *    `http-app.ts` today; WS2's real `requireBearerAuth` later, same shape).
 *  - stdio / auth-off path: no (or no matching) `authInfo` — falls back to
 *    `resources.agentId` (the env-asserted process constant). That fallback
 *    is sound only because the real-provider gate (`provider-factory.ts`)
 *    keeps that path to the dummy provider once `authRequired` is `true` for
 *    the process's transport; while the flag is off program-wide (today's
 *    default), the fallback is the SAME behaviour as before this change.
 *  - NEVER reads a client-supplied id out of tool-call `arguments` — the only
 *    input trusted here is the transport-verified `extra.authInfo`.
 *
 * `extra.authInfo.extra` is typed `Record<string, unknown>` by the SDK, so
 * `profileId` is narrowed defensively: anything other than a non-empty
 * string is treated as "no profile", never as a value to trust.
 */
export function resolvePrincipal(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  resources: ServerResources
): string {
  const rawProfileId = (extra.authInfo?.extra as { profileId?: unknown } | undefined)?.profileId
  const profileId = typeof rawProfileId === 'string' && rawProfileId.length > 0 ? rawProfileId : undefined

  if (resources.authRequired && !profileId) {
    throw new UnauthenticatedError()
  }

  return profileId ?? resources.agentId
}

/**
 * The long-lived resources a running server instance needs. Loaded once per
 * process (both transports share a single set) — the provider, policy, audit
 * logger, and approval queue are stateless-enough to serve many concurrent
 * MCP sessions on the HTTP transport, so there's no need to rebuild them per
 * session.
 */
export interface ServerResources {
  agentId: string
  /** True iff `CLAD_MCP_AUTH=oauth` — see `resolvePrincipal` and the
   *  real-provider gate in `provider-factory.ts`. */
  authRequired: boolean
  policy: PolicyConfig
  provider: FinancialDataProvider
  auditLogger: AuditLogger
  approvalQueue: ApprovalQueue
  /**
   * The OAuth resource-server provider (D5.3 WS2 S2-S3) — defined iff
   * `authRequired` is true, `undefined` otherwise. `http-app.ts` mounts
   * `mcpAuthRouter` only when this is set, so the flag-off path constructs
   * and mounts NOTHING new (behaviour-identical to pre-WS2).
   */
  oauth?: CladOAuthProvider
}

/**
 * Constructs the OAuth resource-server provider (D5.3 WS2 S2-S3) when
 * `authRequired` is true (`CLAD_MCP_AUTH=oauth`). Reads `CLAD_GRANT_DB` (the
 * `SqliteGrantStore` file path) and `CLAD_TOKEN_PASSPHRASE` (the SAME
 * passphrase env var every other store in this process uses — WS5 §3's "zero
 * new key custody" decision) directly from `process.env`, mirroring
 * `provider-factory.ts`'s `createPlaidProvider`/`createSimpleFinProvider`:
 * name every missing var, never run with a partial/implicit config.
 *
 * Returns `undefined` when `authRequired` is false — NOTHING is constructed
 * (`http-app.ts` mounts `mcpAuthRouter` only when `resources.oauth` is set),
 * so the flag-off path stays behaviour-identical to before this change.
 *
 * WS5 §8 "never run keyless": when `authRequired` is true and either env var
 * is missing, this throws a FIXED, secret-free message (never the
 * passphrase, never anything beyond the env VAR NAMES) rather than silently
 * falling back to an unkeyed or default store — an operator who opts into
 * `CLAD_MCP_AUTH=oauth` without also providing a grant-store path and
 * passphrase gets a boot failure, never a silently-keyless OAuth server.
 */
export function loadOAuthProvider(authRequired: boolean): CladOAuthProvider | undefined {
  if (!authRequired) return undefined

  const dbPath = process.env.CLAD_GRANT_DB
  const passphrase = process.env.CLAD_TOKEN_PASSPHRASE

  const missing: string[] = []
  if (!dbPath) missing.push('CLAD_GRANT_DB')
  if (!passphrase) missing.push('CLAD_TOKEN_PASSPHRASE')
  if (missing.length > 0) {
    throw new Error(
      `[clad server] CLAD_MCP_AUTH=oauth requires the following environment ` +
        `variable(s), which are not set: ${missing.join(', ')}. Refusing to start ` +
        'an OAuth-enforced server without a grant store (D5.3 WS5 §8).'
    )
  }

  const dir = dirname(dbPath as string)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  // Throws a redacted error (SqliteGrantStore mirrors SqliteTokenStore's
  // discipline) on a wrong passphrase — propagate so the server fails fast
  // instead of serving with a broken store.
  const store = new SqliteGrantStore({ dbPath: dbPath as string, passphrase: passphrase as string })
  return new CladOAuthProvider({ store })
}

/**
 * Reads the process env, ensures DB directories exist, loads the policy, and
 * constructs the provider/audit/approval singletons. Identical for stdio and
 * HTTP — the env contract (`CLAD_POLICY_PATH`/`CLAD_AUDIT_DB`/
 * `CLAD_APPROVAL_DB`/`CLAD_AGENT_ID`/provider vars) doesn't change with the
 * transport.
 *
 * D5.3 note: `agentId` is still a process-lifetime constant asserted via env
 * here — it now serves only as the stdio/dummy fallback (`resolvePrincipal`).
 * Per-connection authenticated identity is resolved per request from
 * `extra.authInfo` (WS3); this function additionally resolves `authRequired`
 * (`CLAD_MCP_AUTH=oauth`) and the transport mode so the real-provider gate in
 * `provider-factory.ts` can refuse to construct a real provider outside the
 * authenticated HTTP path.
 */
export async function loadServerResources(): Promise<ServerResources> {
  const policyPath = process.env.CLAD_POLICY_PATH ?? './policy.yaml'
  const auditDbPath = process.env.CLAD_AUDIT_DB ?? './audit.sqlite'
  const approvalDbPath = process.env.CLAD_APPROVAL_DB ?? './approvals.sqlite'
  // Agent ID resolution: CLI arg (CLAD_AGENT_ID_ARG) > env var > default
  // CLAD_AGENT_ID_ARG is set by `clad serve --agent-id` before spawning this process
  const agentId = process.env.CLAD_AGENT_ID_ARG ?? process.env.CLAD_AGENT_ID ?? 'default-agent'
  // True only when the operator has explicitly opted into the (currently
  // skeleton) auth-enforced path. Unset/any-other-value == today's default
  // behaviour, byte-identical to pre-WS3.
  const authRequired = process.env.CLAD_MCP_AUTH === 'oauth'
  // Same resolution `server.ts` uses for `CLAD_MCP_TRANSPORT`, read here too
  // (independently) so the real-provider gate can see it — `loadServerResources`
  // runs before `server.ts` inspects this env var itself.
  const transport = process.env.CLAD_MCP_TRANSPORT === 'http' ? 'http' : 'stdio'

  // Ensure parent directories exist for database files
  for (const dbPath of [auditDbPath, approvalDbPath]) {
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  process.stderr.write(`[clad server] loading policy from ${policyPath}\n`)
  const policy = await parsePolicy(policyPath)
  process.stderr.write(`[clad server] policy loaded (${Object.keys(policy.agents ?? {}).length} agents)\n`)
  const provider = await createProvider({ transport, authRequired })
  const auditLogger = new AuditLogger(auditDbPath)
  const approvalQueue = new ApprovalQueue(approvalDbPath)
  // D5.3 WS2 S2-S3: constructs the OAuth resource-server provider iff
  // authRequired — throws at boot (never runs keyless) if CLAD_GRANT_DB /
  // CLAD_TOKEN_PASSPHRASE are missing. Undefined, and nothing constructed,
  // when the flag is off (today's default).
  const oauth = loadOAuthProvider(authRequired)

  // Validate agent ID exists in policy; warn to stderr (not stdout — MCP protocol)
  if (!(agentId in policy.agents)) {
    process.stderr.write(
      `[clad] Warning: agent "${agentId}" not found in policy. All requests will be denied.\n`
    )
  }

  return { agentId, authRequired, policy, provider, auditLogger, approvalQueue, oauth }
}

/**
 * Builds a fresh `Server` with the tool-list and tool-call handlers wired to
 * the shared `handleToolCall`. Returns a NOT-yet-connected server — the
 * caller attaches whichever `Transport` it wants.
 *
 * The SDK binds a `Server` 1:1 to a transport, so the HTTP transport calls
 * this once per MCP session (all sharing the same `resources`), while the
 * stdio transport calls it exactly once for the process.
 */
export function createConfiguredServer(resources: ServerResources): Server {
  const server = new Server(
    { name: 'clad', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    handleToolCall(request, {
      tools,
      // Per-request principal (D5.3 WS3 S1) — resolved from the verified
      // token on the authenticated path, falling back to the env-asserted
      // `resources.agentId` on stdio / auth-off. `handleToolCall` itself is
      // unchanged: it still just takes an `agentId: string`.
      agentId: resolvePrincipal(extra, resources),
      context: {
        policy: resources.policy,
        provider: resources.provider,
        auditLogger: resources.auditLogger,
        approvalQueue: resources.approvalQueue,
      },
      auditLogger: resources.auditLogger,
    })
  )

  return server
}
