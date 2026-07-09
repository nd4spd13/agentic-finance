/**
 * Config port unit tests — mirrors the coverage shape of
 * `packages/cli/test/cli.test.ts`'s "Config" block, plus the desktop-only
 * `plaid_env` extension and the first-run bootstrap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parsePolicy } from '@clad/core'
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  ensureConfigDir,
  ensureConfigBootstrap,
  getConfigPath,
  getConfigDir,
  desktopOnlyPlaidDbPath,
} from '../src/main/lib/config.js'

const TEST_DIR = join(tmpdir(), `clad-desktop-test-${process.pid}`)

beforeEach(() => {
  process.env.CLAD_CONFIG_DIR = TEST_DIR
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  delete process.env.CLAD_CONFIG_DIR
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
})

describe('config', () => {
  it('defaultConfig returns paths under CLAD_CONFIG_DIR', () => {
    const cfg = defaultConfig()
    expect(cfg.policy_path).toContain(TEST_DIR)
    expect(cfg.audit_db).toContain(TEST_DIR)
    expect(cfg.approval_db).toContain(TEST_DIR)
    expect(cfg.plaid_db).toContain(TEST_DIR)
    expect(cfg.simplefin_db).toContain(TEST_DIR)
  })

  it('defaultConfig defaults provider to dummy and plaid_env to sandbox', () => {
    const cfg = defaultConfig()
    expect(cfg.provider).toBe('dummy')
    expect(cfg.plaid_env).toBe('sandbox')
  })

  it('saveConfig + loadConfig roundtrip preserves every field', () => {
    const cfg = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'production' as const }
    saveConfig(cfg)
    const loaded = loadConfig()
    expect(loaded).toEqual(cfg)
  })

  it('loadConfig returns defaults when no config file exists', () => {
    const loaded = loadConfig()
    expect(loaded).toEqual(defaultConfig())
  })

  it('loadConfig defaults plaid_env when absent from an existing config.json (pre-desktop CLI config)', () => {
    ensureConfigDir()
    const legacyConfig = defaultConfig() as Record<string, unknown>
    delete legacyConfig.plaid_env
    writeFileSync(getConfigPath(), JSON.stringify(legacyConfig, null, 2) + '\n', 'utf-8')

    const loaded = loadConfig()
    expect(loaded.plaid_env).toBe('sandbox')
  })

  it('loadConfig defaults simplefin_db when absent from an existing config.json (pre-D3.2 desktop config)', () => {
    ensureConfigDir()
    const legacyConfig = defaultConfig() as Record<string, unknown>
    delete legacyConfig.simplefin_db
    writeFileSync(getConfigPath(), JSON.stringify(legacyConfig, null, 2) + '\n', 'utf-8')

    const loaded = loadConfig()
    expect(loaded.simplefin_db).toBe(defaultConfig().simplefin_db)
  })

  it('loadConfig honors a CLI-authored simplefin_db path (same field the CLI config has always had)', () => {
    ensureConfigDir()
    const customPath = join(TEST_DIR, 'custom-simplefin.sqlite')
    const cliStyleConfig = { ...defaultConfig(), simplefin_db: customPath }
    writeFileSync(getConfigPath(), JSON.stringify(cliStyleConfig, null, 2) + '\n', 'utf-8')

    const loaded = loadConfig()
    expect(loaded.simplefin_db).toBe(customPath)
  })

  it('loadConfig rejects an invalid plaid_env value, falling back to the default', () => {
    ensureConfigDir()
    const badConfig = { ...defaultConfig(), plaid_env: 'development' }
    writeFileSync(getConfigPath(), JSON.stringify(badConfig, null, 2) + '\n', 'utf-8')

    const loaded = loadConfig()
    expect(loaded.plaid_env).toBe('sandbox')
  })

  it('desktopOnlyPlaidDbPath is distinct from the default plaid_db path', () => {
    expect(desktopOnlyPlaidDbPath()).not.toBe(defaultConfig().plaid_db)
    expect(desktopOnlyPlaidDbPath()).toContain(getConfigDir())
    expect(desktopOnlyPlaidDbPath().endsWith('plaid-desktop.sqlite')).toBe(true)
  })

  describe('ensureConfigBootstrap', () => {
    it('creates config.json and a starter policy on a fresh config dir', () => {
      expect(existsSync(getConfigPath())).toBe(false)

      const cfg = ensureConfigBootstrap()

      expect(existsSync(getConfigPath())).toBe(true)
      expect(existsSync(cfg.policy_path)).toBe(true)
    })

    it('the starter policy defines default-agent (matches the server\'s fallback agent id)', () => {
      const cfg = ensureConfigBootstrap()
      const policyText = readFileSync(cfg.policy_path, 'utf-8')
      expect(policyText).toContain('default-agent:')
    })

    /**
     * Regression test for a real bug caught during D1.3 manual QA: the
     * starter policy predated `@clad/core`'s current `policy.schema.json`
     * (which requires `description` + a `permissions` wrapper per agent).
     * `parsePolicy` validates strictly, so the old flat shape made
     * `@clad/mcp-server` throw and exit(1) on every single launch — both
     * this app's own supervised server AND (D1.4) Claude Desktop's spawned
     * server, since both point at this same file. This test would have
     * caught it: a substring check for "default-agent:" (above) is not
     * enough, since the invalid old policy also contained that substring.
     */
    it('the starter policy passes @clad/core\'s real parsePolicy validation (not just a substring check)', async () => {
      const cfg = ensureConfigBootstrap()
      const policy = await parsePolicy(cfg.policy_path)
      expect(policy.agents['default-agent']).toBeDefined()
    })

    it('is a no-op against an existing config.json (never overwrites it)', () => {
      const custom = { ...defaultConfig(), provider: 'plaid' as const }
      saveConfig(custom)

      const cfg = ensureConfigBootstrap()

      expect(cfg.provider).toBe('plaid')
    })

    it('does not overwrite an existing policy file', () => {
      ensureConfigDir()
      const cfg = defaultConfig()
      writeFileSync(cfg.policy_path, 'agents: {}\n# custom user edits\n', 'utf-8')

      ensureConfigBootstrap()

      expect(readFileSync(cfg.policy_path, 'utf-8')).toContain('custom user edits')
    })

    it('fills in a missing policy file even if config.json already exists', () => {
      const cfg = defaultConfig()
      saveConfig(cfg)
      expect(existsSync(cfg.policy_path)).toBe(false)

      ensureConfigBootstrap()

      expect(existsSync(cfg.policy_path)).toBe(true)
    })
  })
})
