import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPolicy, writePolicy } from '../src/main/lib/policy-data.js'

let dir: string
let policyPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-desktop-policy-data-test-'))
  policyPath = join(dir, 'policy.yaml')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const VALID_POLICY = {
  agents: {
    'agent-1': {
      description: 'Test agent',
      permissions: {
        accounts: { visible: ['checking'], balance: true },
        transactions: { read: true, lookback_days: 30 },
      },
    },
  },
  global: {
    max_total_daily_spend: 500,
  },
}

describe('readPolicy', () => {
  it('reports ok: true with an empty policy and empty raw text when the file does not exist yet', async () => {
    const result = await readPolicy(policyPath)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.policy).toEqual({ agents: {} })
      expect(result.raw).toBe('')
    }
  })

  it('reads back a valid policy file, both parsed and raw', async () => {
    await writePolicy(policyPath, VALID_POLICY)
    const result = await readPolicy(policyPath)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.policy).toEqual(VALID_POLICY)
      expect(result.raw).toContain('agent-1')
      expect(result.raw).toContain('max_total_daily_spend')
    }
  })

  it('reports ok: false with a display-safe message when the on-disk file fails schema validation', async () => {
    writeFileSync(
      policyPath,
      'agents:\n  agent-1:\n    permissions: {}\n', // missing required "description"
      'utf-8'
    )
    const result = await readPolicy(policyPath)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Policy validation failed')
    }
  })

  it('reports ok: false when the on-disk file is not valid YAML', async () => {
    writeFileSync(policyPath, 'agents: [this is not: valid: yaml', 'utf-8')
    const result = await readPolicy(policyPath)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0)
    }
  })
})

describe('writePolicy', () => {
  it('rejects a non-object body without touching the filesystem', async () => {
    const result = await writePolicy(policyPath, null)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('policy')
    }
  })

  it('validates via parsePolicy and writes the real file only on success', async () => {
    const result = await writePolicy(policyPath, VALID_POLICY)
    expect(result.ok).toBe(true)

    const written = readFileSync(policyPath, 'utf-8')
    expect(written).toContain('agent-1')
    expect(written).toContain('Test agent')

    const reread = await readPolicy(policyPath)
    expect(reread.ok).toBe(true)
    if (reread.ok) {
      expect(reread.policy).toEqual(VALID_POLICY)
    }
  })

  it('never writes the real file when the proposed policy fails schema validation', async () => {
    writeFileSync(policyPath, 'agents: {}\n', 'utf-8') // pre-existing valid content
    const beforeContent = readFileSync(policyPath, 'utf-8')

    const invalidPolicy = {
      agents: {
        'agent-1': {
          // missing required "description"
          permissions: {},
        },
      },
    }
    const result = await writePolicy(policyPath, invalidPolicy)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Policy validation failed')
    }

    // The real file is untouched — an invalid edit never overwrites the
    // last-known-good policy that the MCP server gate is actually reading.
    expect(readFileSync(policyPath, 'utf-8')).toBe(beforeContent)
  })

  it('cleans up its temp validation directory whether validation succeeds or fails', async () => {
    const listTempDirs = (): string[] =>
      readdirSync(tmpdir()).filter((f) => f.startsWith('clad-desktop-policy-validate-'))
    const before = listTempDirs()

    await writePolicy(policyPath, VALID_POLICY)
    await writePolicy(policyPath, { agents: { a: { permissions: {} } } }) // invalid

    expect(listTempDirs().length).toBe(before.length)
  })
})
