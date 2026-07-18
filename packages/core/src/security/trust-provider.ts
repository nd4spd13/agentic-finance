// Copyright 2024 CRSPY Inc.
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE in the
// repository root for the full license text.

import type { PolicyConfig } from '../types/index.js'

/**
 * The seam through which agent-identity verification and scope minting route.
 *
 * D5.3 ships ONE implementation (`LocalConsentTrustProvider`) whose entire
 * notion of trust is "a human approved this binding in the consent screen".
 * The interface exists so a future KYA plan can supply a richer implementation
 * (attestation, registry lookup, publisher verification) without touching the
 * OAuth provider. Do NOT grow this interface speculatively — see WS7 §7.
 */

/**
 * What we know about a client asking to be bound to a profile.
 * All fields are client-asserted EXCEPT `clientId` (server-issued at DCR)
 * and `dpopJkt` (proven by possession).
 */
export interface AgentIdentityClaim {
  /** Server-issued at Dynamic Client Registration — the one non-spoofable handle. */
  clientId: string
  /** Self-reported at DCR. UNTRUSTED display text (WS4 §7). */
  clientName?: string
  /** Registered redirect URIs — weak signal, but a stable one across re-registrations. */
  redirectUris?: string[]
  /**
   * RFC 7638 thumbprint of a DPoP key the client has proven possession of (M3);
   * absent for bearer-only clients. This is a public-key hash, not secret material.
   */
  dpopJkt?: string
  /**
   * Opaque, implementation-defined attestation material. `unknown` on purpose:
   * D5.3 never reads it, and typing it now would bake in a guess about KYA's
   * eventual shape. A future provider narrows it internally.
   */
  attestation?: unknown
}

/** How much we believe the claim, and what that permits. */
export interface TrustAssessment {
  /**
   * `'none'` — nothing verified (should not reach a grant).
   * `'local-consent'` — a human on this machine approved the binding. The ONLY
   *   level D5.3 produces, and a genuinely meaningful one for a local-first app.
   * `'attested'` — reserved for KYA; never produced by D5.3's implementation.
   */
  assuranceLevel: 'none' | 'local-consent' | 'attested'
  /** Profiles this client may be bound to. D5.3: every profile in the policy (the human chooses among them). */
  eligibleProfiles: string[]
  /**
   * The highest scope sensitivity this client may hold, per parent §10's
   * "gate scope on binding, checked at enrollment". D5.3 derives this purely
   * from DPoP binding: bearer-only -> 'low'; DPoP-bound -> 'high'.
   */
  maxScopeSensitivity: 'low' | 'high'
  /** Display-safe explanation for the consent screen / audit. Never secret material. */
  reason?: string
}

export interface MintScopesRequest {
  profileId: string
  policy: PolicyConfig
  assessment: TrustAssessment
}

export interface TrustProvider {
  /** Called at /authorize, BEFORE the human consent screen is rendered. */
  assessClient(claim: AgentIdentityClaim): Promise<TrustAssessment>
  /** Called at /token (and on refresh). MUST NOT read any client-supplied scope. */
  mintScopes(req: MintScopesRequest): Promise<string[]>
}
