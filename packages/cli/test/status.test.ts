/**
 * `clad status` connections-section tests (SF6).
 *
 * `statusCommand` gained a "Connections" section so a successful
 * `clad connect --provider simplefin` (or `--provider plaid`) is visible
 * afterwards. `SqliteTokenStore.listItems()` returns metadata only (no
 * token/access-URL material), so these assertions focus on: no store file
 * yet, a store file present but no passphrase available, and a store file
 * with a real item once the passphrase is supplied.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const TEST_DIR = join(tmpdir(), `clad-status-test-${process.pid}`)

beforeEach(() => {
  process.env.CLAD_CONFIG_DIR = TEST_DIR
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  delete process.env.CLAD_CONFIG_DIR
  delete process.env.CLAD_TOKEN_PASSPHRASE
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
})

async function captureStatusOutput(): Promise<string> {
  const { statusCommand } = await import('../src/commands/status.js')
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    await statusCommand()
  } finally {
    console.log = orig
  }
  return logs.join('\n')
}

describe('statusCommand connections section', () => {
  it('reports no connections when neither token store file exists', async () => {
    const output = await captureStatusOutput()
    expect(output).toContain('Connections: none linked yet')
  })

  it('reports a store is linked but withholds details without CLAD_TOKEN_PASSPHRASE', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { SqliteTokenStore } = await import('@clad/core')
    const config = loadConfig()
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'p4ss' })
    store.saveItem({
      itemId: 'simplefin-test-item',
      institutionName: 'SimpleFIN Bridge',
      accessToken: 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/xyz',
    })
    store.close()

    const output = await captureStatusOutput()
    expect(output).toContain('simplefin: linked (set CLAD_TOKEN_PASSPHRASE to view details)')
    expect(output).not.toContain('sfin-user:sfin-p4ss')
  })

  it('shows the linked simplefin item (id + institution) once CLAD_TOKEN_PASSPHRASE is set', async () => {
    const { loadConfig } = await import('../src/config.js')
    const { SqliteTokenStore } = await import('@clad/core')
    const config = loadConfig()
    const store = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase: 'p4ss' })
    store.saveItem({
      itemId: 'simplefin-test-item',
      institutionName: 'SimpleFIN Bridge',
      accessToken: 'https://sfin-user:sfin-p4ss@bridge.example.org/simplefin/access/xyz',
    })
    store.close()

    process.env.CLAD_TOKEN_PASSPHRASE = 'p4ss'
    const output = await captureStatusOutput()
    expect(output).toContain('simplefin: 1 item')
    expect(output).toContain('simplefin-test-item')
    expect(output).toContain('SimpleFIN Bridge')
    expect(output).not.toContain('sfin-user:sfin-p4ss')
    expect(output).not.toContain('bridge.example.org/simplefin/access/xyz')
  })
})
