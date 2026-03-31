import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const fixturesDir = join(__dirname, '../../../../fixtures/policies')

describe('Policy Parser', () => {
  describe('parsePolicy()', () => {
    it('parses valid basic YAML into typed PolicyConfig', async () => {
      const { parsePolicy } = await import('../../src/policy/parser.js')
      const result = await parsePolicy(join(fixturesDir, 'valid-basic.yaml'))
      expect(result).toBeDefined()
      expect(result.agents).toHaveProperty('test-agent')
      expect(result.agents['test-agent'].permissions.accounts?.visible).toContain('checking')
    })

    it('parses valid full YAML with all features', async () => {
      const { parsePolicy } = await import('../../src/policy/parser.js')
      const result = await parsePolicy(join(fixturesDir, 'valid-full.yaml'))
      expect(result.agents).toBeDefined()
      expect(Object.keys(result.agents).length).toBeGreaterThan(0)
      expect(result.global).toBeDefined()
    })

    it('throws with clear error on invalid schema', async () => {
      const { parsePolicy } = await import('../../src/policy/parser.js')
      await expect(parsePolicy(join(fixturesDir, 'invalid-schema.yaml')))
        .rejects.toThrow()
    })

    it('returns deny-all default for missing file', async () => {
      const { parsePolicy } = await import('../../src/policy/parser.js')
      const result = await parsePolicy('/non/existent/path.yaml')
      expect(result).toEqual({ agents: {} })
    })

    it('returns deny-all default for empty file', async () => {
      const { parsePolicy } = await import('../../src/policy/parser.js')
      const tmpPath = '/tmp/empty-policy.yaml'
      writeFileSync(tmpPath, '')
      try {
        const result = await parsePolicy(tmpPath)
        expect(result).toEqual({ agents: {} })
      } finally {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      }
    })
  })
})
