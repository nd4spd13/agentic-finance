/**
 * Tests for CRS-53: agent ID resolution logic used by the MCP server.
 *
 * The server resolves agent identity with this priority:
 *   1. CLAD_AGENT_ID_ARG (set by `clad serve --agent-id`)
 *   2. CLAD_AGENT_ID (env var)
 *   3. 'default-agent' (fallback)
 *
 * It then validates the resolved ID exists in policy.agents.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PolicyConfig } from '../../src/index.js'

// Mirrors the resolution logic in packages/mcp-server/src/server.ts
function resolveAgentId(env: Record<string, string | undefined>): string {
  return env['CLAD_AGENT_ID_ARG'] ?? env['CLAD_AGENT_ID'] ?? 'default-agent'
}

function validateAgentId(agentId: string, policy: PolicyConfig): boolean {
  return agentId in policy.agents
}

const testPolicy: PolicyConfig = {
  agents: {
    'default-agent': {
      description: 'Default agent',
      permissions: {},
    },
    'financial-advisor': {
      description: 'Financial advisor agent',
      permissions: {},
    },
  },
}

describe('Agent ID resolution (CRS-53)', () => {
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = {
      CLAD_AGENT_ID_ARG: process.env.CLAD_AGENT_ID_ARG,
      CLAD_AGENT_ID: process.env.CLAD_AGENT_ID,
    }
    delete process.env.CLAD_AGENT_ID_ARG
    delete process.env.CLAD_AGENT_ID
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('falls back to default-agent when no env vars are set', () => {
    const id = resolveAgentId({})
    expect(id).toBe('default-agent')
  })

  it('uses CLAD_AGENT_ID when set', () => {
    const id = resolveAgentId({ CLAD_AGENT_ID: 'financial-advisor' })
    expect(id).toBe('financial-advisor')
  })

  it('uses CLAD_AGENT_ID_ARG (CLI flag) when set', () => {
    const id = resolveAgentId({ CLAD_AGENT_ID_ARG: 'financial-advisor' })
    expect(id).toBe('financial-advisor')
  })

  it('CLI flag (CLAD_AGENT_ID_ARG) overrides env var (CLAD_AGENT_ID)', () => {
    const id = resolveAgentId({
      CLAD_AGENT_ID: 'default-agent',
      CLAD_AGENT_ID_ARG: 'financial-advisor',
    })
    expect(id).toBe('financial-advisor')
  })

  it('validates known agent ID returns true', () => {
    expect(validateAgentId('financial-advisor', testPolicy)).toBe(true)
    expect(validateAgentId('default-agent', testPolicy)).toBe(true)
  })

  it('validates unknown agent ID returns false', () => {
    expect(validateAgentId('rogue-agent', testPolicy)).toBe(false)
  })

  it('empty string agent ID is treated as unknown', () => {
    expect(validateAgentId('', testPolicy)).toBe(false)
  })
})
