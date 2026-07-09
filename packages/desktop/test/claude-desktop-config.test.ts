/**
 * Unit tests for the D1.4 "Connect to Claude Desktop" merge/diff logic.
 * Per the testing constraint in desktop-app.md, everything here operates on
 * temp files under `os.tmpdir()` — never the user's real
 * `~/Library/Application Support/Claude/claude_desktop_config.json` (or the
 * Windows equivalent). The real path is only ever computed in
 * `src/main/index.ts` via `claudeDesktopConfigPath(app.getPath('appData'))`,
 * which is not exercised here.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCladMcpServerEntry,
  isClaudeDesktopInstalled,
  readExistingConfig,
  mergeCladEntry,
  isAlreadyConnected,
  writeConfig,
  formatConfigJson,
  type McpServerEntry,
} from '../src/main/lib/claude-desktop-config.js'
import type { CladConfig } from '../src/main/lib/config.js'

function fakeConfig(overrides: Partial<CladConfig> = {}): CladConfig {
  return {
    policy_path: '/fake/.clad/policy.yaml',
    audit_db: '/fake/.clad/audit.sqlite',
    approval_db: '/fake/.clad/approvals.sqlite',
    server_pid_file: '/fake/.clad/server.pid',
    provider: 'dummy',
    plaid_db: '/fake/.clad/plaid.sqlite',
    plaid_env: 'sandbox',
    close_to_tray: true,
    ...overrides,
  }
}

let dir: string | undefined

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('buildCladMcpServerEntry', () => {
  it('builds command/args/env from config + execPath + agentId, with only path-shaped env vars plus CLAD_AGENT_ID', () => {
    const entry = buildCladMcpServerEntry(fakeConfig(), '/fake/Clad.app/Contents/MacOS/Clad', 'finance-agent')

    expect(entry.command).toBe('/fake/Clad.app/Contents/MacOS/Clad')
    expect(entry.args).toHaveLength(1)
    expect(entry.args[0]).toMatch(/server\.js$/)
    expect(entry.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      CLAD_POLICY_PATH: '/fake/.clad/policy.yaml',
      CLAD_AUDIT_DB: '/fake/.clad/audit.sqlite',
      CLAD_APPROVAL_DB: '/fake/.clad/approvals.sqlite',
      CLAD_AGENT_ID: 'finance-agent',
    })
  })

  /**
   * Regression test for D1 manual QA finding 2: a prior version of this
   * function wrote no CLAD_AGENT_ID at all, so the spawned server fell back
   * to mcp-server/src/server.ts's hardcoded 'default-agent' — which fails
   * every tool call ("unknown agent: default-agent") against any real-world
   * policy that doesn't happen to define an agent by that exact name (the
   * repro: a policy defining only 'analyst' and 'finance-agent').
   */
  it('always includes CLAD_AGENT_ID set to the resolved agent id, never omitted', () => {
    const entry = buildCladMcpServerEntry(fakeConfig(), '/fake/exec', 'analyst')

    expect(entry.env.CLAD_AGENT_ID).toBe('analyst')
  })

  it('never includes Plaid secrets or CLAD_PROVIDER, even when provider is "plaid"', () => {
    const entry = buildCladMcpServerEntry(fakeConfig({ provider: 'plaid' }), '/fake/exec', 'default-agent')

    const keys = Object.keys(entry.env)
    expect(keys).not.toContain('CLAD_PROVIDER')
    expect(keys).not.toContain('PLAID_CLIENT_ID')
    expect(keys).not.toContain('PLAID_SECRET')
    expect(keys).not.toContain('PLAID_ENV')
    expect(keys).not.toContain('CLAD_TOKEN_PASSPHRASE')
    expect(keys.sort()).toEqual(
      ['CLAD_AGENT_ID', 'CLAD_APPROVAL_DB', 'CLAD_AUDIT_DB', 'CLAD_POLICY_PATH', 'ELECTRON_RUN_AS_NODE'].sort()
    )
  })
})

describe('isClaudeDesktopInstalled', () => {
  it('is false when the app-support directory does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-claude-config-test-'))
    const configPath = join(dir, 'Claude', 'claude_desktop_config.json')

    expect(isClaudeDesktopInstalled(configPath)).toBe(false)
  })

  it('is true once the app-support directory exists, even with no config file yet', () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-claude-config-test-'))
    const claudeDir = join(dir, 'Claude')
    mkdirSync(claudeDir)
    const configPath = join(claudeDir, 'claude_desktop_config.json')

    expect(existsSync(configPath)).toBe(false)
    expect(isClaudeDesktopInstalled(configPath)).toBe(true)
  })
})

describe('readExistingConfig', () => {
  it('returns {} when the file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-claude-config-test-'))
    expect(readExistingConfig(join(dir, 'nope.json'))).toEqual({})
  })

  it('parses a valid existing config', () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-claude-config-test-'))
    const configPath = join(dir, 'claude_desktop_config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'x', args: [], env: {} } } }))

    expect(readExistingConfig(configPath)).toEqual({
      mcpServers: { other: { command: 'x', args: [], env: {} } },
    })
  })

  it('returns {} (never throws) for malformed JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-claude-config-test-'))
    const configPath = join(dir, 'claude_desktop_config.json')
    writeFileSync(configPath, '{ this is not valid json')

    expect(readExistingConfig(configPath)).toEqual({})
  })

  it('returns {} for a top-level JSON array (not a valid config shape)', () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-claude-config-test-'))
    const configPath = join(dir, 'claude_desktop_config.json')
    writeFileSync(configPath, '[1, 2, 3]')

    expect(readExistingConfig(configPath)).toEqual({})
  })
})

describe('mergeCladEntry', () => {
  const cladEntry: McpServerEntry = {
    command: '/fake/exec',
    args: ['/fake/server.js'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }

  it('adds mcpServers.clad to an empty config', () => {
    expect(mergeCladEntry({}, cladEntry)).toEqual({ mcpServers: { clad: cladEntry } })
  })

  it('preserves other top-level keys and other mcpServers entries', () => {
    const existing = {
      someOtherSetting: 'keep-me',
      mcpServers: {
        other: { command: 'other-cmd', args: ['--flag'], env: {} },
      },
    }

    const merged = mergeCladEntry(existing, cladEntry)

    expect(merged.someOtherSetting).toBe('keep-me')
    expect((merged.mcpServers as Record<string, unknown>).other).toEqual(existing.mcpServers.other)
    expect((merged.mcpServers as Record<string, unknown>).clad).toEqual(cladEntry)
  })

  it('overwrites a stale existing clad entry rather than merging its fields', () => {
    const existing = {
      mcpServers: { clad: { command: 'old-cmd', args: ['old'], env: { OLD: '1' } } },
    }

    const merged = mergeCladEntry(existing, cladEntry)

    expect((merged.mcpServers as Record<string, unknown>).clad).toEqual(cladEntry)
  })
})

describe('isAlreadyConnected', () => {
  const cladEntry: McpServerEntry = {
    command: '/fake/exec',
    args: ['/fake/server.js'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }

  it('is false when there is no existing clad entry', () => {
    expect(isAlreadyConnected({}, cladEntry)).toBe(false)
  })

  it('is true when the existing clad entry deep-equals the proposed one', () => {
    const existing = { mcpServers: { clad: { ...cladEntry } } }
    expect(isAlreadyConnected(existing, cladEntry)).toBe(true)
  })

  it('is false when the existing clad entry differs (e.g. a stale path)', () => {
    const existing = { mcpServers: { clad: { ...cladEntry, command: '/old/exec' } } }
    expect(isAlreadyConnected(existing, cladEntry)).toBe(false)
  })
})

describe('writeConfig + full merge round trip', () => {
  it('creates the parent directory and writes pretty-printed JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-claude-config-test-'))
    const configPath = join(dir, 'Claude', 'claude_desktop_config.json')
    const merged = { mcpServers: { clad: { command: '/fake', args: [], env: {} } } }

    writeConfig(configPath, merged)

    expect(existsSync(configPath)).toBe(true)
    expect(readFileSync(configPath, 'utf-8')).toBe(formatConfigJson(merged))
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(merged)
  })

  it('end-to-end: existing config with another server survives a connect, stale clad entry gets replaced', () => {
    dir = mkdtempSync(join(tmpdir(), 'clad-desktop-claude-config-test-'))
    const claudeDir = join(dir, 'Claude')
    mkdirSync(claudeDir)
    const configPath = join(claudeDir, 'claude_desktop_config.json')
    const preExisting = {
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: {} },
        clad: { command: '/old/exec', args: ['/old/server.js'], env: { STALE: '1' } },
      },
    }
    writeFileSync(configPath, JSON.stringify(preExisting, null, 2))

    expect(isClaudeDesktopInstalled(configPath)).toBe(true)
    const existing = readExistingConfig(configPath)
    const cladEntry = buildCladMcpServerEntry(fakeConfig(), '/new/exec', 'default-agent')
    expect(isAlreadyConnected(existing, cladEntry)).toBe(false)

    const merged = mergeCladEntry(existing, cladEntry)
    writeConfig(configPath, merged)

    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.mcpServers.filesystem).toEqual(preExisting.mcpServers.filesystem)
    expect(written.mcpServers.clad).toEqual(cladEntry)
    expect(written.mcpServers.clad.env.STALE).toBeUndefined()
  })
})
