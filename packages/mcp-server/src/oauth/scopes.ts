/**
 * The static OAuth scope vocabulary Clad advertises (D5.3 WS2 §4.1/§4.2, §6 —
 * `.claude/plans/d5.3/WS2-oauth-resource-server.md`).
 *
 * This is the vocabulary the two `/.well-known/*` metadata documents'
 * `scopes_supported` field is built from (`http-app.ts`'s `mcpAuthRouter`
 * mount, `scopesSupported: CLAD_SCOPES`). It is deliberately just the static
 * list — WS2 §6's `mintScopesForProfile(policy, profileId)` (the function
 * that derives the ACTUAL scope set for a consented grant from
 * `policy.agents[profile].permissions`) is Wave 4 scope (§7 S4-S5, gated on
 * the consent UI / WS4). That future minter is required to read its output
 * set from THIS constant — never invent its own scope strings — so the
 * vocabulary Clad advertises here and the vocabulary it actually mints from
 * can never drift apart.
 */
export const CLAD_SCOPES = [
  'clad:accounts.read',
  'clad:transactions.read',
  'clad:actions.request',
  'clad:audit.read',
] as const

export type CladScope = (typeof CLAD_SCOPES)[number]
