/**
 * Regression tests for D1 manual QA finding 2: the Claude Desktop connect
 * entry must always resolve to an agent ID that actually exists in the
 * policy it's pointed at, never a silently-wrong hardcoded default. Exercised
 * against real temp policy files + `@clad/core`'s real `parsePolicy` (same
 * pattern `config.test.ts` already uses for the starter-policy regression
 * test) — no fakes, since schema validation is exactly the thing that bit
 * D1.3/D1.4 before.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveClaudeDesktopAgentId,
  resolveSupervisedAgentId,
  FALLBACK_AGENT_ID,
} from '../src/main/lib/agent-resolution.js'

const AGENT_PERMISSIONS_YAML = `    permissions:
      accounts:
        visible: []
        balance: true
        account_number: false
        routing_number: false
      transactions:
        read: true
        description_visibility: true
        lookback_days: 30
      audit:
        log_all_queries: true
        log_policy_evaluations: true`

const SINGLE_AGENT_POLICY = `agents:
  finance-agent:
    description: Single-agent test policy.
${AGENT_PERMISSIONS_YAML}
`

const MULTI_AGENT_POLICY = `agents:
  analyst:
    description: Multi-agent test policy — analyst.
${AGENT_PERMISSIONS_YAML}
  finance-agent:
    description: Multi-agent test policy — finance-agent.
${AGENT_PERMISSIONS_YAML}
`

// Real-world repro shape from the finding: no 'default-agent' at all.
const REPRO_POLICY = MULTI_AGENT_POLICY

let dir: string | undefined

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

function writePolicy(content: string): string {
  dir = mkdtempSync(join(tmpdir(), 'clad-desktop-agent-resolution-test-'))
  const policyPath = join(dir, 'policy.yaml')
  writeFileSync(policyPath, content, 'utf-8')
  return policyPath
}

describe('resolveClaudeDesktopAgentId', () => {
  it('resolves the sole agent when the policy defines exactly one', async () => {
    const policyPath = writePolicy(SINGLE_AGENT_POLICY)

    const result = await resolveClaudeDesktopAgentId(policyPath)

    expect(result.agentId).toBe('finance-agent')
    expect(result.availableAgentIds).toEqual(['finance-agent'])
    expect(result.fallbackReason).toBeUndefined()
  })

  it('honors an explicitly requested agent id that exists in a multi-agent policy (repro: analyst + finance-agent, no default-agent)', async () => {
    const policyPath = writePolicy(REPRO_POLICY)

    const result = await resolveClaudeDesktopAgentId(policyPath, 'analyst')

    expect(result.agentId).toBe('analyst')
    expect(result.availableAgentIds.sort()).toEqual(['analyst', 'finance-agent'])
    expect(result.fallbackReason).toBeUndefined()
  })

  it('picks a deterministic default among multiple agents when none was explicitly requested', async () => {
    const policyPath = writePolicy(MULTI_AGENT_POLICY)

    const result = await resolveClaudeDesktopAgentId(policyPath)

    expect(result.availableAgentIds.sort()).toEqual(['analyst', 'finance-agent'])
    expect(result.availableAgentIds).toContain(result.agentId)
    // Deterministic: alphabetically first.
    expect(result.agentId).toBe('analyst')
    expect(result.fallbackReason).toBeUndefined()
  })

  it('ignores a requested agent id that does not exist in the policy, falling back to the deterministic default (never a bare pass-through)', async () => {
    const policyPath = writePolicy(MULTI_AGENT_POLICY)

    const result = await resolveClaudeDesktopAgentId(policyPath, 'nonexistent-agent')

    expect(result.availableAgentIds).toContain(result.agentId)
    expect(result.agentId).not.toBe('nonexistent-agent')
  })

  it('falls back to default-agent with a reason when the policy file is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-agent-resolution-test-'))
    const policyPath = join(dir, 'does-not-exist.yaml')

    const result = await resolveClaudeDesktopAgentId(policyPath)

    expect(result.agentId).toBe(FALLBACK_AGENT_ID)
    expect(result.availableAgentIds).toEqual([])
    expect(result.fallbackReason).toBeTruthy()
  })

  it('falls back to default-agent with a reason when the policy fails schema validation (pre-permissions-wrapper shape)', async () => {
    // The exact latent bug config.test.ts's starter-policy regression test
    // guards against: old flat `agents.<id>.accounts`/`.transactions` with
    // no `description`/`permissions` wrapper fails @clad/core's current
    // schema.
    const policyPath = writePolicy('agents:\n  legacy-agent:\n    accounts: {}\n    transactions: {}\n')

    const result = await resolveClaudeDesktopAgentId(policyPath)

    expect(result.agentId).toBe(FALLBACK_AGENT_ID)
    expect(result.availableAgentIds).toEqual([])
    expect(result.fallbackReason).toBeTruthy()
  })

  it('falls back to default-agent with a reason when the policy is empty (no agents at all)', async () => {
    const policyPath = writePolicy('agents: {}\n')

    const result = await resolveClaudeDesktopAgentId(policyPath)

    expect(result.agentId).toBe(FALLBACK_AGENT_ID)
    expect(result.availableAgentIds).toEqual([])
    expect(result.fallbackReason).toBeTruthy()
  })
})

/**
 * v0.5.0 regression — the identity the SUPERVISED child asserts. Same
 * resolution as above (deliberately, so the connect preview and the running
 * child can never disagree), plus the `warning` classification the status UI
 * needs so an all-deny configuration is never silent.
 */
describe('resolveSupervisedAgentId', () => {
  it('resolves a real policy agent — not default-agent — when nothing is configured yet (the exact repro policy)', async () => {
    const policyPath = writePolicy(REPRO_POLICY)

    const result = await resolveSupervisedAgentId(policyPath, '')

    expect(result.agentId).toBe('analyst')
    expect(result.agentId).not.toBe(FALLBACK_AGENT_ID)
    // Not a misconfiguration — this is the backward-compatible default, and
    // it's a valid identity, so there is nothing to warn the user about.
    expect(result.warning).toBeUndefined()
  })

  it('honors a configured agent id that exists in the policy, with no warning', async () => {
    const policyPath = writePolicy(REPRO_POLICY)

    const result = await resolveSupervisedAgentId(policyPath, 'finance-agent')

    expect(result.agentId).toBe('finance-agent')
    expect(result.warning).toBeUndefined()
  })

  it('treats a whitespace-only configured id as unset', async () => {
    const policyPath = writePolicy(SINGLE_AGENT_POLICY)

    const result = await resolveSupervisedAgentId(policyPath, '   ')

    expect(result.agentId).toBe('finance-agent')
    expect(result.warning).toBeUndefined()
  })

  it('warns (naming both the missing agent and the substitute) when the configured id is no longer in the policy', async () => {
    const policyPath = writePolicy(REPRO_POLICY)

    const result = await resolveSupervisedAgentId(policyPath, 'removed-agent')

    // Runs as a real agent rather than a name the policy has never heard of.
    expect(result.agentId).toBe('analyst')
    expect(result.warning).toContain('removed-agent')
    expect(result.warning).toContain('analyst')
  })

  it('warns that calls will be denied when the policy cannot supply any valid identity', async () => {
    const policyPath = writePolicy('agents: {}\n')

    const result = await resolveSupervisedAgentId(policyPath, 'analyst')

    expect(result.agentId).toBe(FALLBACK_AGENT_ID)
    expect(result.warning).toMatch(/denied/i)
  })

  it('warns rather than throwing when the policy file is missing entirely', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-agent-resolution-test-'))
    const policyPath = join(dir, 'does-not-exist.yaml')

    const result = await resolveSupervisedAgentId(policyPath, 'analyst')

    expect(result.agentId).toBe(FALLBACK_AGENT_ID)
    expect(result.warning).toBeTruthy()
  })
})
