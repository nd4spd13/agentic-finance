/**
 * The single server-side scope authority (D5.3 WS2 §6 —
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md`).
 *
 * `mintScopesForProfile` is the ONLY function allowed to produce a scope set,
 * and it derives that set purely from `policy.agents[profileId].permissions` —
 * it NEVER reads a client-supplied `scope`. This is the WS2 §6 invariant that
 * makes acceptance #2 ("scope binds to a server-minted authority, not a client
 * claim") hold: a client cannot widen its own grant by asking for more.
 *
 * `scopeSensitivity` classifies a scope for the parent §10 DPoP gate: only the
 * action-bearing scope is high-sensitivity, so a bearer-only client is never
 * minted it (`LocalConsentTrustProvider.mintScopes` filters on this). Both
 * functions are pure and deterministic — the same `(policy, profileId)` always
 * mints the same set, so re-consent and refresh are stable.
 *
 * WS7 note: these two functions are injected into `LocalConsentTrustProvider`
 * (`@clad/core`) at construction, which is why they live here as standalone
 * exports rather than as methods on `CladOAuthProvider` — `@clad/core` cannot
 * import `@clad/mcp-server` (wrong dependency direction), so the trust provider
 * receives them by constructor injection (see `server-core.ts`).
 */

import type { PolicyConfig } from '@clad/core'
import { CLAD_SCOPES, type CladScope } from './scopes.js'

/**
 * Derives the scope set for a profile from policy, in the fixed
 * {@link CLAD_SCOPES} order so the output is deterministic.
 *
 * Mapping (WS2 §6):
 *  - `accounts.visible` non-empty OR `accounts.balance` → `clad:accounts.read`
 *  - `transactions.read` → `clad:transactions.read`
 *  - any `spending.*` (action-bearing) → `clad:actions.request` (high sensitivity)
 *  - `audit` present → `clad:audit.read`
 *
 * An unknown profile (not in `policy.agents`) mints the empty set — never a
 * default or a client-influenced one.
 */
export function mintScopesForProfile(policy: PolicyConfig, profileId: string): CladScope[] {
  const agent = policy.agents?.[profileId]
  if (agent === undefined) return []

  const perms = agent.permissions
  const granted = new Set<CladScope>()

  const accounts = perms.accounts
  if (accounts !== undefined && ((accounts.visible?.length ?? 0) > 0 || accounts.balance === true)) {
    granted.add('clad:accounts.read')
  }
  if (perms.transactions?.read === true) {
    granted.add('clad:transactions.read')
  }
  // Any spending configuration is action-bearing — the presence of the block
  // (even empty) signals the profile is allowed to REQUEST spending actions.
  if (perms.spending !== undefined) {
    granted.add('clad:actions.request')
  }
  if (perms.audit !== undefined) {
    granted.add('clad:audit.read')
  }

  // Emit in CLAD_SCOPES order for determinism.
  return CLAD_SCOPES.filter((s) => granted.has(s))
}

/**
 * Classifies a scope's sensitivity for the parent §10 DPoP gate. Only the
 * action-bearing scope is `'high'`; every read scope is `'low'`. A DPoP-bound
 * client may hold high-sensitivity scopes; a bearer-only client may not.
 */
export function scopeSensitivity(scope: string): 'low' | 'high' {
  return scope === 'clad:actions.request' ? 'high' : 'low'
}
