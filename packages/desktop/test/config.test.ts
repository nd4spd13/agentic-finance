/**
 * Config port unit tests — mirrors the coverage shape of
 * `packages/cli/test/cli.test.ts`'s "Config" block, plus the desktop-only
 * `plaid_env` extension and the first-run bootstrap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
