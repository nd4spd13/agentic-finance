/**
 * Unit coverage for `resolvePrincipal` (D5.3 WS3 S1 —
 * `.claude/plans/d5.3/WS3-resource-enforcement.md` §3/§8/§9).
 *
 * `resolvePrincipal` is the single place per-request identity is decided:
 * a verified `profileId` from `extra.authInfo.extra` on the authenticated
 * path, or the env-asserted `resources.agentId` fallback otherwise. It never
 * looks at anything else — in particular it has no parameter through which a
 * client-supplied tool-call argument could reach it, which is the structural
 * proof behind "a client-supplied id is never consulted" below.
 */

import { describe, it, expect } from 'vitest'
import type { AuditLogger, ApprovalQueue, PolicyConfig, FinancialDataProvider } from '@clad/core'
import {
  resolvePrincipal,
  UnauthenticatedError,
  type ServerResources,
} from '../src/server-core.js'

const POLICY: PolicyConfig = { agents: { 'env-fallback-agent': { description: 'fallback', permissions: {} } } }

function makeResources(overrides: Partial<ServerResources> = {}): ServerResources {
  return {
    agentId: 'env-fallback-agent',
    authRequired: false,
    policy: POLICY,
    provider: {} as FinancialDataProvider,
    auditLogger: {} as AuditLogger,
    approvalQueue: {} as ApprovalQueue,
    ...overrides,
  }
}

/**
 * Builds a minimal fixture standing in for the SDK's
 * `RequestHandlerExtra<ServerRequest, ServerNotification>` — `resolvePrincipal`
 * only ever reads `.authInfo`, so the rest of the real shape (`signal`,
 * `sendRequest`, etc.) is irrelevant to these tests.
 */
function makeExtra(authInfo?: unknown): Parameters<typeof resolvePrincipal>[0] {
  return { authInfo } as Parameters<typeof resolvePrincipal>[0]
}

describe('resolvePrincipal', () => {
  it('a verified profileId from extra.authInfo.extra wins over resources.agentId', () => {
    const resources = makeResources({ authRequired: true })
    const extra = makeExtra({ token: 't', clientId: 'static', scopes: [], extra: { profileId: 'analyst' } })

    expect(resolvePrincipal(extra, resources)).toBe('analyst')
  })

  it('authRequired && no profileId throws UnauthenticatedError', () => {
    const resources = makeResources({ authRequired: true })
    const extra = makeExtra(undefined)

    expect(() => resolvePrincipal(extra, resources)).toThrow(UnauthenticatedError)
  })

  it('stdio fallback: no authInfo and authRequired=false returns the env agentId', () => {
    const resources = makeResources({ authRequired: false, agentId: 'default-agent' })
    const extra = makeExtra(undefined)

    expect(resolvePrincipal(extra, resources)).toBe('default-agent')
  })

  it('never consults a client-supplied id — the function has no request/arguments parameter at all', () => {
    // Structural proof: resolvePrincipal's signature is (extra, resources).
    // There is no third "request" parameter through which `arguments` could
    // flow in, so a spoofed id sitting in tool-call arguments (or anywhere
    // else on the request) is unreachable by construction.
    expect(resolvePrincipal.length).toBe(2)
  })

  it('ignores a spoofed id placed anywhere on `extra` other than authInfo.extra.profileId', () => {
    const resources = makeResources({ authRequired: false, agentId: 'default-agent' })
    // Simulate a hypothetical caller mistakenly attaching request data
    // elsewhere on the extra object; resolvePrincipal must not pick it up.
    const extra = {
      authInfo: undefined,
      arguments: { agentId: 'attacker', profileId: 'attacker' },
      agentId: 'attacker',
    } as unknown as Parameters<typeof resolvePrincipal>[0]

    expect(resolvePrincipal(extra, resources)).toBe('default-agent')
  })

  describe('malformed extra.authInfo.extra (§9) — always treated as unauthenticated, never a silent fallback bypass', () => {
    it('authInfo.extra is entirely absent', () => {
      const resources = makeResources({ authRequired: true })
      const extra = makeExtra({ token: 't', clientId: 'static', scopes: [] })

      expect(() => resolvePrincipal(extra, resources)).toThrow(UnauthenticatedError)
    })

    it('authInfo.extra.profileId is not a string (number)', () => {
      const resources = makeResources({ authRequired: true })
      const extra = makeExtra({ token: 't', clientId: 'static', scopes: [], extra: { profileId: 12345 } })

      expect(() => resolvePrincipal(extra, resources)).toThrow(UnauthenticatedError)
    })

    it('authInfo.extra.profileId is an empty string', () => {
      const resources = makeResources({ authRequired: true })
      const extra = makeExtra({ token: 't', clientId: 'static', scopes: [], extra: { profileId: '' } })

      expect(() => resolvePrincipal(extra, resources)).toThrow(UnauthenticatedError)
    })

    it('authInfo.extra is a non-object primitive', () => {
      const resources = makeResources({ authRequired: true })
      const extra = makeExtra({ token: 't', clientId: 'static', scopes: [], extra: 'not-an-object' })

      expect(() => resolvePrincipal(extra, resources)).toThrow(UnauthenticatedError)
    })

    it('authInfo itself is entirely absent (no header reached the transport)', () => {
      const resources = makeResources({ authRequired: true })
      const extra = makeExtra(undefined)

      expect(() => resolvePrincipal(extra, resources)).toThrow(UnauthenticatedError)
    })
  })

  it('when authRequired is false, a malformed/absent profile still falls back to resources.agentId (not an error)', () => {
    const resources = makeResources({ authRequired: false, agentId: 'default-agent' })
    const extra = makeExtra({ token: 't', clientId: 'static', scopes: [], extra: { profileId: 999 } })

    expect(resolvePrincipal(extra, resources)).toBe('default-agent')
  })

  it('UnauthenticatedError carries a fixed, secret-free message with no interpolation', () => {
    const err = new UnauthenticatedError()
    expect(err.message).not.toContain('undefined')
    expect(err.name).toBe('UnauthenticatedError')
    // Constructing it twice must yield byte-identical messages — proof there
    // is no per-call interpolation of any request/token-derived value.
    expect(new UnauthenticatedError().message).toBe(err.message)
  })
})
