/**
 * Display-safe view types for `SqliteGrantStore` (see `grant-store.ts`).
 *
 * `GrantMeta` is the shape that crosses the IPC / renderer boundary for WS4's
 * connected-clients list and any future consent UI. It deliberately carries
 * **no** secret or hash column: no client secret, no access/refresh token hash,
 * no auth-code hash, no PKCE challenge. `clientName` is the only free-text field
 * and is display text by design (encrypted at rest for PII, decrypted here for
 * showing to the human who is reviewing their connected agents).
 *
 * Mirrors the `StoredItemMeta` discipline in `token-store.types.ts`: a distinct
 * metadata type is the mechanism that keeps secret material from ever being
 * enumerated to a caller that only needs to list.
 */

/**
 * Metadata about a single consented grant, safe to display or send over IPC.
 * Never contains token/secret/hash material.
 */
export interface GrantMeta {
  grantId: string
  clientId: string
  /** Self-reported client display name (UNTRUSTED text); encrypted at rest, decrypted for display. */
  clientName?: string
  profileId: string
  scopes: string[]
  dpopBound: boolean
  createdAt: string
  lastUsedAt?: string
  revoked: boolean
  /**
   * Trust assurance recorded at consent (WS7 seam). Display-safe metadata, no
   * secret material. `'none'` never reaches a persisted grant; D5.3 only ever
   * produces `'local-consent'`; `'attested'` is reserved for a future KYA phase.
   */
  assuranceLevel: 'none' | 'local-consent' | 'attested'
  /**
   * The highest scope sensitivity this grant's client may hold, recorded at
   * consent (WS7 seam). Derived from DPoP binding at assessment time; display-safe.
   */
  maxScopeSensitivity: 'low' | 'high'
}
