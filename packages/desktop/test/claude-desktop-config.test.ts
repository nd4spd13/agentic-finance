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
  mcpRemoteConfigDir,
  isClaudeDesktopInstalled,
  readExistingConfig,
  mergeCladEntry,
  isAlreadyConnected,
  writeConfig,
  formatConfigJson,
  type McpServerEntry,
} from '../src/main/lib/claude-desktop-config.js'
import { DEFAULT_MCP_HTTP_PORT } from '../src/main/lib/mcp-loopback.js'

let dir: string | undefined

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

const FAKE_MCP_REMOTE_CONFIG_DIR = '/fake/userData/mcp-remote/claude-desktop'

describe('mcpRemoteConfigDir', () => {
  it('scopes the per-app mcp-remote state directory under userData/mcp-remote/claude-desktop', () => {
    expect(mcpRemoteConfigDir('/Users/x/Library/Application Support/Clad')).toBe(
      '/Users/x/Library/Application Support/Clad/mcp-remote/claude-desktop'
    )
  })
})

describe('buildCladMcpServerEntry', () => {
  it('builds an mcp-remote invocation targeting the loopback HTTP URL, with ELECTRON_RUN_AS_NODE + MCP_REMOTE_CONFIG_DIR in env', () => {
    const entry = buildCladMcpServerEntry(
      '/fake/Clad.app/Contents/MacOS/Clad',
      DEFAULT_MCP_HTTP_PORT,
      FAKE_MCP_REMOTE_CONFIG_DIR
    )

    expect(entry.command).toBe('/fake/Clad.app/Contents/MacOS/Clad')
    // args = [absolute mcp-remote proxy entry, loopback MCP URL]
    expect(entry.args).toHaveLength(2)
    expect(entry.args[0]).toMatch(/mcp-remote[/\\]dist[/\\]proxy\.js$/)
    expect(entry.args[1]).toBe(`http://127.0.0.1:${DEFAULT_MCP_HTTP_PORT}/mcp`)
    expect(entry.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      MCP_REMOTE_CONFIG_DIR: FAKE_MCP_REMOTE_CONFIG_DIR,
    })
  })

  it('uses the given port in the loopback URL', () => {
    const entry = buildCladMcpServerEntry('/fake/exec', 51234, FAKE_MCP_REMOTE_CONFIG_DIR)

    expect(entry.args[1]).toBe('http://127.0.0.1:51234/mcp')
  })

  /**
   * v0.7.1 fix #6 (QA finding (b) — Claude Code silently reused Claude
   * Desktop's approved connection with no browser auth): the entry must
   * carry its OWN `MCP_REMOTE_CONFIG_DIR`, distinct from whatever directory
   * any other `mcp-remote` invocation against the same loopback URL uses —
   * see `claude-desktop-config.ts`'s module doc for the full mechanism
   * (mcp-remote keys its DCR client identity + tokens + callback-port
   * coordination lockfile off this directory).
   */
  it('carries its own MCP_REMOTE_CONFIG_DIR scoped under the given userData path', () => {
    const entry = buildCladMcpServerEntry('/fake/exec', DEFAULT_MCP_HTTP_PORT, mcpRemoteConfigDir('/fake/userData'))

    expect(entry.env.MCP_REMOTE_CONFIG_DIR).toBe('/fake/userData/mcp-remote/claude-desktop')
  })

  /**
   * The entry must NEVER carry a secret or a provider selection — Claude
   * Desktop's config is plaintext, and the loopback child (not this proxy)
   * owns the passphrase/provider. This is the core of the "no secret in any
   * config file" property of the fix. `MCP_REMOTE_CONFIG_DIR` is a plain
   * directory path — no secret material — so it's exempt from this list.
   */
  it('never includes any CLAD_* env var, secret, or CLAD_PROVIDER', () => {
    const entry = buildCladMcpServerEntry('/fake/exec', DEFAULT_MCP_HTTP_PORT, FAKE_MCP_REMOTE_CONFIG_DIR)

    const keys = Object.keys(entry.env).sort()
    expect(keys).toEqual(['ELECTRON_RUN_AS_NODE', 'MCP_REMOTE_CONFIG_DIR'])
    expect(keys).not.toContain('CLAD_PROVIDER')
    expect(keys).not.toContain('CLAD_AGENT_ID')
    expect(keys).not.toContain('PLAID_CLIENT_ID')
    expect(keys).not.toContain('PLAID_SECRET')
    expect(keys).not.toContain('CLAD_TOKEN_PASSPHRASE')
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
    const cladEntry = buildCladMcpServerEntry('/new/exec', DEFAULT_MCP_HTTP_PORT, FAKE_MCP_REMOTE_CONFIG_DIR)
    expect(isAlreadyConnected(existing, cladEntry)).toBe(false)

    const merged = mergeCladEntry(existing, cladEntry)
    writeConfig(configPath, merged)

    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.mcpServers.filesystem).toEqual(preExisting.mcpServers.filesystem)
    expect(written.mcpServers.clad).toEqual(cladEntry)
    expect(written.mcpServers.clad.env.STALE).toBeUndefined()
  })
})
