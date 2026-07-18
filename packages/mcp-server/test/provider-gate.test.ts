/**
 * Compat-matrix coverage for the STAGED real-provider gate in `createProvider`
 * (D5.3 WS3 S2, `../src/provider-factory.ts` — see that file's doc comment,
 * and `.claude/plans/d5.3/WS3-resource-enforcement.md` §5, for the full
 * rationale behind the orchestrator-sanctioned deviation from the design
 * doc's literal "unauthenticated == always refuse a real provider" snippet).
 *
 * Extends `provider-factory.test.ts` (which covers the credential-shape
 * branches of `createProvider` with the default gate) by pinning the five
 * points of the STAGED gate's compatibility matrix:
 *
 *  - stdio + real provider + no auth   -> ALLOWED, warns   (today's `clad
 *    serve` path — `serve.ts` forwards `CLAD_PROVIDER` but never sets
 *    `CLAD_MCP_TRANSPORT`, so it always runs stdio).
 *  - http  + real provider + no auth   -> ALLOWED, warns   (today's desktop
 *    supervised-child path — `mcp-server-env.ts` sets `CLAD_MCP_TRANSPORT=http`
 *    but not `CLAD_MCP_AUTH`).
 *  - http  + real provider + auth      -> ALLOWED, no warning (the target
 *    state the full gate converges to once Wave 6 flips the flag).
 *  - stdio + real provider + auth      -> THROWS a fixed, secret-free message.
 *  - dummy                             -> ALLOWED under every gate combination,
 *    and never warns.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DummyDataProvider } from '@clad/core'
import { SimpleFinAdapter } from '@clad/simplefin-adapter'
import type { ProviderGate } from '../src/provider-factory.js'

const PROVIDER_ENV_KEYS = ['CLAD_PROVIDER', 'CLAD_TOKEN_PASSPHRASE', 'CLAD_SIMPLEFIN_DB'] as const

describe('createProvider — staged real-provider gate compat matrix (D5.3 WS3 S2)', () => {
  const originalEnv: Record<string, string | undefined> = {}
  let dir: string

  beforeEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
    dir = mkdtempSync(join(tmpdir(), 'clad-provider-gate-'))
    process.env.CLAD_PROVIDER = 'simplefin'
    process.env.CLAD_TOKEN_PASSPHRASE = 'test-passphrase'
    process.env.CLAD_SIMPLEFIN_DB = join(dir, 'simplefin.sqlite')
  })

  afterEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('stdio + real provider + no auth: ALLOWED, with a redacted stderr warning (clad serve today)', async () => {
    const { createProvider } = await import('../src/provider-factory.js')
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const provider = await createProvider({ transport: 'stdio', authRequired: false })
      expect(provider).toBeInstanceOf(SimpleFinAdapter)
      const warned = writeSpy.mock.calls.some(
        ([msg]) => typeof msg === 'string' && msg.includes('WARNING') && msg.includes('CLAD_MCP_AUTH=oauth')
      )
      expect(warned).toBe(true)
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('http + real provider + no auth: ALLOWED, with a warning (desktop supervised child today)', async () => {
    const { createProvider } = await import('../src/provider-factory.js')
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const provider = await createProvider({ transport: 'http', authRequired: false })
      expect(provider).toBeInstanceOf(SimpleFinAdapter)
      const warned = writeSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('WARNING'))
      expect(warned).toBe(true)
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('http + real provider + auth: ALLOWED, no warning (the target state)', async () => {
    const { createProvider } = await import('../src/provider-factory.js')
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const provider = await createProvider({ transport: 'http', authRequired: true })
      expect(provider).toBeInstanceOf(SimpleFinAdapter)
      const warned = writeSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('WARNING'))
      expect(warned).toBe(false)
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('stdio + real provider + auth: THROWS a fixed, secret-free error naming the required config', async () => {
    const { createProvider } = await import('../src/provider-factory.js')
    const gate: ProviderGate = { transport: 'stdio', authRequired: true }
    const error = await createProvider(gate).then(
      () => {
        throw new Error('expected createProvider to reject')
      },
      (e: unknown) => e as Error
    )
    expect(error.message).toMatch(/authenticated HTTP transport/)
    expect(error.message).toMatch(/CLAD_MCP_TRANSPORT=http/)
    expect(error.message).toMatch(/CLAD_MCP_AUTH=oauth/)
    // Secret-free: the passphrase configured in beforeEach must never appear.
    expect(error.message).not.toContain('test-passphrase')
  })

  it('http + real provider + auth is allowed, but stdio + real + auth throws — the gate keys off transport, not just authRequired', async () => {
    const { createProvider } = await import('../src/provider-factory.js')
    await expect(createProvider({ transport: 'http', authRequired: true })).resolves.toBeInstanceOf(
      SimpleFinAdapter
    )
    await expect(createProvider({ transport: 'stdio', authRequired: true })).rejects.toThrow(
      /authenticated HTTP transport/
    )
  })

  it('dummy is allowed under every gate combination and never warns', async () => {
    process.env.CLAD_PROVIDER = 'dummy'
    const { createProvider } = await import('../src/provider-factory.js')
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const gates: ProviderGate[] = [
        { transport: 'stdio', authRequired: false },
        { transport: 'stdio', authRequired: true },
        { transport: 'http', authRequired: false },
        { transport: 'http', authRequired: true },
      ]
      for (const gate of gates) {
        const provider = await createProvider(gate)
        expect(provider).toBeInstanceOf(DummyDataProvider)
      }
      expect(writeSpy).not.toHaveBeenCalled()
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('the default gate (no argument) preserves pre-WS3 behaviour: stdio + no auth, warns on a real provider', async () => {
    const { createProvider } = await import('../src/provider-factory.js')
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const provider = await createProvider()
      expect(provider).toBeInstanceOf(SimpleFinAdapter)
      expect(writeSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('WARNING'))).toBe(
        true
      )
    } finally {
      writeSpy.mockRestore()
    }
  })
})
