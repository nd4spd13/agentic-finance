// Copyright 2024 CRSPY Inc.
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE in the
// repository root for the full license text.

import type { PolicyConfig } from '../types/index.js'
import type { AgentIdentityClaim, MintScopesRequest, TrustAssessment, TrustProvider } from './trust-provider.js'

/**
 * D5.3's only TrustProvider: trust == a human approved it locally.
 *
 * Deliberately thin. It does not verify publishers, check registries, or
 * inspect `attestation` — those are KYA's job. What it DOES encode is the
 * parent plan's §10 enrollment gate: a bearer-only client can never be minted
 * a high-sensitivity (action-bearing) scope, regardless of the profile chosen.
 *
 * NOTE: This class takes injected dependencies for `mintScopesForProfile` and
 * `scopeSensitivity` because those are WS2 functions that will eventually live
 * in `@clad/mcp-server`, which cannot be imported by `@clad/core` (wrong dependency
 * direction). When those functions are ready, wire them via constructor injection.
 */
export class LocalConsentTrustProvider implements TrustProvider {
  constructor(
    private policy: PolicyConfig,
    private mintScopesForProfile: (policy: PolicyConfig, profileId: string) => string[],
    private scopeSensitivity: (scope: string) => 'low' | 'high',
  ) {}

  async assessClient(claim: AgentIdentityClaim): Promise<TrustAssessment> {
    return {
      assuranceLevel: 'local-consent',
      eligibleProfiles: Object.keys(this.policy.agents), // the human picks among all of them
      maxScopeSensitivity: claim.dpopJkt ? 'high' : 'low', // parent §10 gate
      reason: claim.dpopJkt
        ? 'Client proved possession of a DPoP key.'
        : 'Bearer-only client — high-privilege scopes are unavailable.',
    }
  }

  async mintScopes({ profileId, policy, assessment }: MintScopesRequest): Promise<string[]> {
    const all = this.mintScopesForProfile(policy, profileId) // WS2 §6 — unchanged, still the derivation
    return assessment.maxScopeSensitivity === 'high'
      ? all
      : all.filter((s) => this.scopeSensitivity(s) === 'low') // drop action-bearing scopes for bearer clients
  }
}
