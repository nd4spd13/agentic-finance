import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DummyDataProvider } from '@clad/core'
import {
  createFinancialProvider,
  missingPlaidPrereqs,
  providerFingerprint,
} from '../src/main/lib/provider-factory.js'
import type { CladConfig } from '../src/main/lib/config.js'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function makeConfig(overrides: Partial<CladConfig> = {}): CladConfig {
  const base = dir ?? (dir = mkdtempSync(join(tmpdir(), 'clad-desktop-provider-factory-test-')))
  return {
    policy_path: join(base, 'policy.yaml'),
    audit_db: join(base, 'audit.sqlite'),
    approval_db: join(base, 'approvals.sqlite'),
    server_pid_file: join(base, 'server.pid'),
    provider: 'dummy',
    plaid_db: join(base, 'plaid.sqlite'),
    plaid_env: 'sandbox',
    close_to_tray: true,
    ...overrides,
  }
}

describe('missingPlaidPrereqs', () => {
  it('lists both when neither is present', () => {
    const missing = missingPlaidPrereqs({ plaidCredentials: null, passphrase: null })
    expect(missing).toHaveLength(2)
  })

  it('is empty when both are present', () => {
    const missing = missingPlaidPrereqs({
      plaidCredentials: { clientId: 'id', secret: 'sec' },
      passphrase: 'pass',
    })
    expect(missing).toEqual([])
  })

  it('lists only the missing one', () => {
    expect(
      missingPlaidPrereqs({ plaidCredentials: { clientId: 'id', secret: 'sec' }, passphrase: null })
    ).toHaveLength(1)
    expect(missingPlaidPrereqs({ plaidCredentials: null, passphrase: 'pass' })).toHaveLength(1)
  })
})

describe('providerFingerprint', () => {
  it('differs when provider, credentials presence, or passphrase presence differ', () => {
    const config = makeConfig()
    const base = providerFingerprint({ config, plaidCredentials: null, passphrase: null })
    expect(providerFingerprint({ config: { ...config, provider: 'plaid' }, plaidCredentials: null, passphrase: null })).not.toBe(base)
    expect(
      providerFingerprint({ config, plaidCredentials: { clientId: 'a', secret: 'b' }, passphrase: null })
    ).not.toBe(base)
    expect(providerFingerprint({ config, plaidCredentials: null, passphrase: 'p' })).not.toBe(base)
  })

  it('is stable for identical inputs', () => {
    const config = makeConfig()
    const a = providerFingerprint({ config, plaidCredentials: { clientId: 'a', secret: 'b' }, passphrase: 'p' })
    const b = providerFingerprint({ config, plaidCredentials: { clientId: 'a', secret: 'b' }, passphrase: 'p' })
    expect(a).toBe(b)
  })

  it('never embeds credential/passphrase values, only presence', () => {
    const config = makeConfig({ provider: 'plaid' })
    const fp = providerFingerprint({
      config,
      plaidCredentials: { clientId: 'super-secret-client-id', secret: 'super-secret-secret' },
      passphrase: 'super-secret-passphrase',
    })
    expect(fp).not.toContain('super-secret')
  })
})

describe('createFinancialProvider', () => {
  it('returns a DummyDataProvider for provider: dummy, ignoring plaid inputs entirely', async () => {
    const config = makeConfig({ provider: 'dummy' })
    const result = await createFinancialProvider({ config, plaidCredentials: null, passphrase: null })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.provider).toBeInstanceOf(DummyDataProvider)
    }
  })

  it('fails with a display-safe message when plaid is selected but nothing is configured', async () => {
    const config = makeConfig({ provider: 'plaid' })
    const result = await createFinancialProvider({ config, plaidCredentials: null, passphrase: null })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Client ID/Secret')
      expect(result.error).toContain('passphrase')
    }
  })

  it('fails with a redacted message when plaid_env is invalid despite credentials/passphrase being present', async () => {
    const config = makeConfig({ provider: 'plaid', plaid_env: 'not-a-real-env' as CladConfig['plaid_env'] })
    const result = await createFinancialProvider({
      config,
      plaidCredentials: { clientId: 'my-client-id-xyz', secret: 'my-super-secret-value' },
      passphrase: 'pass',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('PLAID_ENV')
      // Never echoes the credential values themselves back in the error text.
      expect(result.error).not.toContain('my-super-secret-value')
      expect(result.error).not.toContain('my-client-id-xyz')
    }
  })
})
