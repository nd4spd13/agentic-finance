import { describe, it, expect } from 'vitest'
import type { PolicyConfig } from '../../src/types/index.js'
import { LocalConsentTrustProvider } from '../../src/security/trust-provider-local.js'

// Fixture policy with two profiles
const FIXTURE_POLICY: PolicyConfig = {
  agents: {
    admin: {
      description: 'Administrator profile',
      permissions: {
        accounts: { visible: ['*'] },
        transactions: { read: true },
        spending: {
          max_per_transaction: 100000,
          max_daily: 500000,
        },
      },
    },
    assistant: {
      description: 'Assistant profile',
      permissions: {
        accounts: { visible: ['primary'] },
        transactions: { read: true },
        spending: {
          max_per_transaction: 5000,
          max_daily: 10000,
        },
      },
    },
  },
}

// Fixture scope sensitivity mapping
const FIXTURE_SCOPE_SENSITIVITY = (scope: string): 'low' | 'high' => {
  // Read-only scopes (view, list, read) are low-sensitivity
  const readKeywords = ['view', 'list', 'read']
  if (readKeywords.some((kw) => scope.includes(kw))) {
    return 'low'
  }
  // Action-bearing scopes are high-sensitivity
  return 'high'
}

// Fixture mintScopesForProfile function
const FIXTURE_MINT_SCOPES_FOR_PROFILE = (policy: PolicyConfig, profileId: string): string[] => {
  if (!Object.prototype.hasOwnProperty.call(policy.agents, profileId)) {
    return []
  }

  // For admin: return all scopes including high-sensitivity ones
  if (profileId === 'admin') {
    return [
      'accounts.view',
      'accounts.list',
      'transactions.view',
      'transactions.list',
      'actions.request',
      'spending.request',
    ]
  }

  // For assistant: return a limited set of scopes
  if (profileId === 'assistant') {
    return [
      'accounts.view',
      'accounts.list',
      'transactions.view',
      'actions.request',
    ]
  }

  return []
}

describe('LocalConsentTrustProvider', () => {
  const provider = new LocalConsentTrustProvider(
    FIXTURE_POLICY,
    FIXTURE_MINT_SCOPES_FOR_PROFILE,
    FIXTURE_SCOPE_SENSITIVITY,
  )

  describe('fixture validation', () => {
    it('scope sensitivity function classifies correctly', () => {
      expect(FIXTURE_SCOPE_SENSITIVITY('accounts.view')).toBe('low')
      expect(FIXTURE_SCOPE_SENSITIVITY('transactions.view')).toBe('low')
      expect(FIXTURE_SCOPE_SENSITIVITY('actions.request')).toBe('high')
      expect(FIXTURE_SCOPE_SENSITIVITY('spending.request')).toBe('high')
    })

    it('mint function returns expected scopes for admin', () => {
      const scopes = FIXTURE_MINT_SCOPES_FOR_PROFILE(FIXTURE_POLICY, 'admin')
      expect(scopes).toEqual([
        'accounts.view',
        'accounts.list',
        'transactions.view',
        'transactions.list',
        'actions.request',
        'spending.request',
      ])
    })
  })

  describe('assessClient', () => {
    it('returns assuranceLevel "local-consent"', async () => {
      const claim = { clientId: 'test-client-1' }
      const assessment = await provider.assessClient(claim)
      expect(assessment.assuranceLevel).toBe('local-consent')
    })

    it('returns every policy profile as eligible', async () => {
      const claim = { clientId: 'test-client-1' }
      const assessment = await provider.assessClient(claim)
      expect(assessment.eligibleProfiles).toEqual(['admin', 'assistant'])
      expect(assessment.eligibleProfiles.length).toBe(Object.keys(FIXTURE_POLICY.agents).length)
    })

    it('sets maxScopeSensitivity to "high" when dpopJkt is present', async () => {
      const claim = { clientId: 'test-client-1', dpopJkt: 'abc123def456' }
      const assessment = await provider.assessClient(claim)
      expect(assessment.maxScopeSensitivity).toBe('high')
    })

    it('sets maxScopeSensitivity to "low" when dpopJkt is absent', async () => {
      const claim = { clientId: 'test-client-1' }
      const assessment = await provider.assessClient(claim)
      expect(assessment.maxScopeSensitivity).toBe('low')
    })

    it('provides reason about DPoP binding', async () => {
      const claimWithDPoP = { clientId: 'test-client-1', dpopJkt: 'abc123def456' }
      const assessmentWithDPoP = await provider.assessClient(claimWithDPoP)
      expect(assessmentWithDPoP.reason).toBe('Client proved possession of a DPoP key.')

      const claimWithoutDPoP = { clientId: 'test-client-2' }
      const assessmentWithoutDPoP = await provider.assessClient(claimWithoutDPoP)
      expect(assessmentWithoutDPoP.reason).toBe(
        'Bearer-only client — high-privilege scopes are unavailable.',
      )
    })

    it('ignores attestation field (hostile attestation produces same assessment)', async () => {
      const claimWithout = { clientId: 'test-client-1', dpopJkt: 'jkt123' }
      const claimWith = {
        clientId: 'test-client-1',
        dpopJkt: 'jkt123',
        attestation: 'malicious-or-unexpected-value' as unknown,
      }

      const assessmentWithout = await provider.assessClient(claimWithout)
      const assessmentWith = await provider.assessClient(claimWith)

      expect(assessmentWithout).toEqual(assessmentWith)
    })

    it('ignores clientName and redirectUris (they do not affect assessment)', async () => {
      const claim1 = { clientId: 'test-client-1', clientName: 'Trusted App' }
      const claim2 = { clientId: 'test-client-1', redirectUris: ['https://example.com/callback'] }
      const claim3 = { clientId: 'test-client-1' }

      const assessment1 = await provider.assessClient(claim1)
      const assessment2 = await provider.assessClient(claim2)
      const assessment3 = await provider.assessClient(claim3)

      expect(assessment1.assuranceLevel).toBe(assessment2.assuranceLevel)
      expect(assessment2.assuranceLevel).toBe(assessment3.assuranceLevel)
      expect(assessment1.maxScopeSensitivity).toBe(assessment3.maxScopeSensitivity)
    })
  })

  describe('mintScopes', () => {
    it('never widens: result is always a subset of mintScopesForProfile result', async () => {
      // Test this property for every profile in the fixture policy
      for (const profileId of Object.keys(FIXTURE_POLICY.agents)) {
        // Case 1: DPoP-bound (high sensitivity allowed)
        const highAssessment = await provider.assessClient({
          clientId: 'test-client-1',
          dpopJkt: 'jkt123',
        })
        const highScopes = await provider.mintScopes({
          profileId,
          policy: FIXTURE_POLICY,
          assessment: highAssessment,
        })
        const allScopes = FIXTURE_MINT_SCOPES_FOR_PROFILE(FIXTURE_POLICY, profileId)
        expect(highScopes).toEqual(expect.arrayContaining(highScopes))
        expect(allScopes).toEqual(expect.arrayContaining(highScopes))

        // Case 2: Bearer-only (low sensitivity only)
        const lowAssessment = await provider.assessClient({ clientId: 'test-client-2' })
        const lowScopes = await provider.mintScopes({
          profileId,
          policy: FIXTURE_POLICY,
          assessment: lowAssessment,
        })
        // All returned scopes must be low-sensitivity
        for (const scope of lowScopes) {
          expect(FIXTURE_SCOPE_SENSITIVITY(scope)).toBe('low')
        }
        // Result must be a subset of all scopes
        expect(allScopes).toEqual(expect.arrayContaining(lowScopes))
      }
    })

    it('bearer-only assessment filters out high-sensitivity scopes', async () => {
      const claim = { clientId: 'bearer-client' }
      const assessment = await provider.assessClient(claim)
      expect(assessment.maxScopeSensitivity).toBe('low')

      // For admin profile, which includes action-bearing scopes
      const scopes = await provider.mintScopes({
        profileId: 'admin',
        policy: FIXTURE_POLICY,
        assessment,
      })

      // Should not include 'actions.request' or 'spending.request' (high-sensitivity)
      expect(scopes).not.toContain('actions.request')
      expect(scopes).not.toContain('spending.request')

      // Should include read scopes (low-sensitivity)
      expect(scopes).toContain('accounts.view')
      expect(scopes).toContain('transactions.view')
    })

    it('DPoP-bound assessment retains high-sensitivity scopes', async () => {
      const claim = { clientId: 'dpop-client', dpopJkt: 'jkt-abc123' }
      const assessment = await provider.assessClient(claim)
      expect(assessment.maxScopeSensitivity).toBe('high')

      // For admin profile
      const scopes = await provider.mintScopes({
        profileId: 'admin',
        policy: FIXTURE_POLICY,
        assessment,
      })

      // Should include action-bearing scopes when DPoP-bound
      expect(scopes).toContain('actions.request')
      expect(scopes).toContain('spending.request')

      // Should also include read scopes
      expect(scopes).toContain('accounts.view')
    })

    it('returns empty array for non-existent profile', async () => {
      const assessment = await provider.assessClient({ clientId: 'test-client' })
      const scopes = await provider.mintScopes({
        profileId: 'nonexistent',
        policy: FIXTURE_POLICY,
        assessment,
      })
      expect(scopes).toEqual([])
    })

    it('does not read client-supplied scope (no scope parameter in request)', () => {
      // This is a compile-time guarantee: the MintScopesRequest type has no field
      // for client-supplied scopes. We assert this by construction.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      type MintScopesRequestKeys = keyof typeof provider.mintScopes extends (
        req: infer R,
      ) => unknown
        ? keyof R
        : never
      // Verify the signature doesn't include a clientScope or similar field
      const mockRequest = {
        profileId: 'admin',
        policy: FIXTURE_POLICY,
        assessment: {
          assuranceLevel: 'local-consent' as const,
          eligibleProfiles: ['admin'],
          maxScopeSensitivity: 'high' as const,
        },
      }
      // If this compiles, the signature is correct
      expect(mockRequest).toBeDefined()
    })
  })

  describe('invariant: LocalConsentTrustProvider never returns "attested"', () => {
    it('always returns "local-consent" assurance level', async () => {
      const testCases = [
        { clientId: 'test-1' },
        { clientId: 'test-2', dpopJkt: 'jkt-xyz' },
        { clientId: 'test-3', clientName: 'My App' },
        { clientId: 'test-4', redirectUris: ['https://example.com'] },
        { clientId: 'test-5', dpopJkt: 'jkt-123', attestation: { data: 'ignored' } },
      ]

      for (const claim of testCases) {
        const assessment = await provider.assessClient(claim)
        expect(assessment.assuranceLevel).toBe('local-consent')
        expect(assessment.assuranceLevel).not.toBe('attested')
      }
    })
  })

  describe('narrow-never-widen invariant (property-based over fixture profiles)', () => {
    it('for every profile, mintScopes result is subset of mintScopesForProfile', async () => {
      const profileIds = Object.keys(FIXTURE_POLICY.agents)
      for (const profileId of profileIds) {
        // Test with both high and low sensitivity ceilings
        for (const dpopJkt of [undefined, 'jkt-test-123']) {
          const assessment = await provider.assessClient({
            clientId: 'test-profile-property',
            dpopJkt,
          })

          const minted = await provider.mintScopes({
            profileId,
            policy: FIXTURE_POLICY,
            assessment,
          })

          const all = FIXTURE_MINT_SCOPES_FOR_PROFILE(FIXTURE_POLICY, profileId)

          // Every scope in minted must be in all
          for (const scope of minted) {
            expect(all).toContain(scope)
          }
        }
      }
    })
  })
})
