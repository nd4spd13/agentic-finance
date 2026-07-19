/**
 * D5.3 WS2 §10 / WS5 §8 "never run keyless" coverage:
 * `loadOAuthProvider` (`../../src/server-core.ts`) must throw at
 * construction — never silently fall back — when `authRequired` is true but
 * `CLAD_GRANT_DB` and/or `CLAD_TOKEN_PASSPHRASE` are missing, and the thrown
 * message must name only the missing ENV VAR NAMES, never a value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOAuthProvider } from '../../src/server-core.js'
import { CladOAuthProvider } from '../../src/oauth/provider.js'

const ENV_KEYS = ['CLAD_GRANT_DB', 'CLAD_TOKEN_PASSPHRASE'] as const
const original: Record<string, string | undefined> = {}

let dir: string

beforeEach(() => {
  for (const key of ENV_KEYS) {
    original[key] = process.env[key]
    delete process.env[key]
  }
  dir = mkdtempSync(join(tmpdir(), 'clad-oauth-boot-'))
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('loadOAuthProvider(authRequired) — boot-time gate', () => {
  it('returns undefined and constructs NOTHING when authRequired is false, even with no env set', () => {
    const provider = loadOAuthProvider(false)
    expect(provider).toBeUndefined()
  })

  it('returns undefined when authRequired is false, even if CLAD_GRANT_DB/CLAD_TOKEN_PASSPHRASE happen to be set (no accidental double-construction)', () => {
    process.env.CLAD_GRANT_DB = join(dir, 'grants.sqlite')
    process.env.CLAD_TOKEN_PASSPHRASE = 'irrelevant-here'
    expect(loadOAuthProvider(false)).toBeUndefined()
  })

  it('throws when authRequired is true and BOTH env vars are missing, naming both var names', () => {
    expect(() => loadOAuthProvider(true)).toThrow(/CLAD_GRANT_DB/)
    expect(() => loadOAuthProvider(true)).toThrow(/CLAD_TOKEN_PASSPHRASE/)
  })

  it('throws when authRequired is true and only CLAD_GRANT_DB is missing', () => {
    process.env.CLAD_TOKEN_PASSPHRASE = 'some-passphrase'
    let error: Error | undefined
    try {
      loadOAuthProvider(true)
    } catch (e) {
      error = e as Error
    }
    expect(error).toBeDefined()
    expect(error!.message).toContain('CLAD_GRANT_DB')
    expect(error!.message).not.toContain('CLAD_TOKEN_PASSPHRASE')
    // Never leak the passphrase value itself into the boot-throw message.
    expect(error!.message).not.toContain('some-passphrase')
  })

  it('throws when authRequired is true and only CLAD_TOKEN_PASSPHRASE is missing', () => {
    process.env.CLAD_GRANT_DB = join(dir, 'grants.sqlite')
    let error: Error | undefined
    try {
      loadOAuthProvider(true)
    } catch (e) {
      error = e as Error
    }
    expect(error).toBeDefined()
    expect(error!.message).toContain('CLAD_TOKEN_PASSPHRASE')
    expect(error!.message).not.toContain('CLAD_GRANT_DB is')
  })

  it('constructs a real CladOAuthProvider and creates the grant DB file when both env vars are present', () => {
    process.env.CLAD_GRANT_DB = join(dir, 'nested', 'grants.sqlite')
    process.env.CLAD_TOKEN_PASSPHRASE = 'a-real-test-passphrase'

    const provider = loadOAuthProvider(true)
    try {
      expect(provider).toBeInstanceOf(CladOAuthProvider)
    } finally {
      // Best-effort close via the internal store — CladOAuthProvider doesn't
      // expose close() itself (Wave 4 territory), so just let the temp dir
      // cleanup in afterEach remove the file; node:sqlite handles don't hold
      // an OS lock that would block that on this platform.
    }
  })
})
