/**
 * D5.3 WS2 §6 coverage: `mintScopesForProfile` / `scopeSensitivity`
 * (`../../src/oauth/scope-minter.ts`) — the single server-side scope authority.
 *
 * The load-bearing invariants (WS2 §6):
 *  1. Scope derives ONLY from `policy.agents[profile].permissions` — never from a
 *     client-supplied `scope` (guaranteed by construction: the signature takes
 *     no request/scope parameter).
 *  2. Deterministic and emitted in the fixed CLAD_SCOPES order, so re-consent /
 *     refresh mint the same set.
 *  3. An action-bearing (`spending`) profile is high-sensitivity.
 */

import { describe, it, expect } from 'vitest'
import type { PolicyConfig } from '@clad/core'
import { mintScopesForProfile, scopeSensitivity } from '../../src/oauth/scope-minter.js'
import { CLAD_SCOPES } from '../../src/oauth/scopes.js'

const POLICY: PolicyConfig = {
  agents: {
    reader: {
      description: 'accounts + transactions reader',
      permissions: { accounts: { visible: ['checking'], balance: true }, transactions: { read: true } },
    },
    balanceOnly: {
      description: 'balance access, no transactions',
      permissions: { accounts: { visible: [], balance: true } },
    },
    spender: {
      description: 'action-bearing',
      permissions: { accounts: { visible: ['checking'] }, spending: {} },
    },
    auditor: {
      description: 'audit reader',
      permissions: { audit: {} },
    },
    empty: {
      description: 'no permissions',
      permissions: {},
    },
  },
}

describe('mintScopesForProfile', () => {
  it('maps accounts + transactions permissions to their read scopes', () => {
    expect(mintScopesForProfile(POLICY, 'reader')).toEqual(['clad:accounts.read', 'clad:transactions.read'])
  })

  it('mints clad:accounts.read from balance access alone (no visible accounts)', () => {
    expect(mintScopesForProfile(POLICY, 'balanceOnly')).toEqual(['clad:accounts.read'])
  })

  it('mints the high-sensitivity clad:actions.request from a spending block', () => {
    const scopes = mintScopesForProfile(POLICY, 'spender')
    expect(scopes).toContain('clad:actions.request')
    expect(scopeSensitivity('clad:actions.request')).toBe('high')
  })

  it('mints clad:audit.read from an audit block', () => {
    expect(mintScopesForProfile(POLICY, 'auditor')).toEqual(['clad:audit.read'])
  })

  it('mints the empty set for a permission-less profile and for an unknown profile', () => {
    expect(mintScopesForProfile(POLICY, 'empty')).toEqual([])
    expect(mintScopesForProfile(POLICY, 'does-not-exist')).toEqual([])
  })

  it('is deterministic and emitted in fixed CLAD_SCOPES order', () => {
    const once = mintScopesForProfile(POLICY, 'reader')
    const twice = mintScopesForProfile(POLICY, 'reader')
    expect(once).toEqual(twice)
    // Order matches the canonical vocabulary order.
    const ordered = [...once].sort((a, b) => CLAD_SCOPES.indexOf(a) - CLAD_SCOPES.indexOf(b))
    expect(once).toEqual(ordered)
  })
})

describe('scopeSensitivity', () => {
  it('classifies only clad:actions.request as high; every read scope is low', () => {
    expect(scopeSensitivity('clad:actions.request')).toBe('high')
    expect(scopeSensitivity('clad:accounts.read')).toBe('low')
    expect(scopeSensitivity('clad:transactions.read')).toBe('low')
    expect(scopeSensitivity('clad:audit.read')).toBe('low')
  })
})
