import { describe, it, expect } from 'vitest'
import { buildServerEnv } from '../src/main/lib/mcp-server-env.js'
import { defaultConfig } from '../src/main/lib/config.js'

describe('buildServerEnv', () => {
  it('sets the non-secret config paths (including CLAD_SIMPLEFIN_DB, unconditionally) and ELECTRON_RUN_AS_NODE for the dummy provider', () => {
    const config = { ...defaultConfig(), provider: 'dummy' as const }

    const env = buildServerEnv(config)

    expect(env.CLAD_POLICY_PATH).toBe(config.policy_path)
    expect(env.CLAD_AUDIT_DB).toBe(config.audit_db)
    expect(env.CLAD_APPROVAL_DB).toBe(config.approval_db)
    expect(env.CLAD_PROVIDER).toBe('dummy')
    expect(env.CLAD_PLAID_DB).toBe(config.plaid_db)
    expect(env.CLAD_SIMPLEFIN_DB).toBe(config.simplefin_db)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('never sets PLAID_* or CLAD_TOKEN_PASSPHRASE for the dummy provider, even if secrets are (mistakenly) passed', () => {
    const config = { ...defaultConfig(), provider: 'dummy' as const }

    const env = buildServerEnv(config, {
      plaid: { clientId: 'client-123', secret: 'shh-secret', passphrase: 'the-passphrase' },
      simplefin: { passphrase: 'the-passphrase' },
    })

    expect(env.PLAID_CLIENT_ID).toBeUndefined()
    expect(env.PLAID_SECRET).toBeUndefined()
    expect(env.PLAID_ENV).toBeUndefined()
    expect(env.CLAD_TOKEN_PASSPHRASE).toBeUndefined()
  })

  it('sets PLAID_* and CLAD_TOKEN_PASSPHRASE for the plaid provider when secrets are supplied', () => {
    const config = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'production' as const }

    const env = buildServerEnv(config, {
      plaid: { clientId: 'client-123', secret: 'shh-secret', passphrase: 'the-passphrase' },
    })

    expect(env.PLAID_CLIENT_ID).toBe('client-123')
    expect(env.PLAID_SECRET).toBe('shh-secret')
    expect(env.PLAID_ENV).toBe('production')
    expect(env.CLAD_TOKEN_PASSPHRASE).toBe('the-passphrase')
  })

  it('omits PLAID_* for the plaid provider when no secrets are supplied (defensive — callers should pre-flight this)', () => {
    const config = { ...defaultConfig(), provider: 'plaid' as const }

    const env = buildServerEnv(config)

    expect(env.PLAID_CLIENT_ID).toBeUndefined()
    expect(env.CLAD_TOKEN_PASSPHRASE).toBeUndefined()
  })

  it('sets CLAD_TOKEN_PASSPHRASE (but no PLAID_*) for the simplefin provider when a passphrase is supplied', () => {
    const config = { ...defaultConfig(), provider: 'simplefin' as const }

    const env = buildServerEnv(config, { simplefin: { passphrase: 'sfin-passphrase' } })

    expect(env.CLAD_TOKEN_PASSPHRASE).toBe('sfin-passphrase')
    expect(env.PLAID_CLIENT_ID).toBeUndefined()
    expect(env.PLAID_SECRET).toBeUndefined()
    expect(env.PLAID_ENV).toBeUndefined()
  })

  it('omits CLAD_TOKEN_PASSPHRASE for the simplefin provider when no passphrase is supplied (defensive — callers should pre-flight this)', () => {
    const config = { ...defaultConfig(), provider: 'simplefin' as const }

    const env = buildServerEnv(config)

    expect(env.CLAD_TOKEN_PASSPHRASE).toBeUndefined()
  })

  it('ignores a plaid secret passed alongside provider: simplefin (and vice versa)', () => {
    const config = { ...defaultConfig(), provider: 'simplefin' as const }

    const env = buildServerEnv(config, {
      plaid: { clientId: 'client-123', secret: 'shh-secret', passphrase: 'plaid-passphrase' },
    })

    expect(env.PLAID_CLIENT_ID).toBeUndefined()
    expect(env.CLAD_TOKEN_PASSPHRASE).toBeUndefined()
  })

  it('always forwards CLAD_SIMPLEFIN_DB and CLAD_PLAID_DB regardless of which provider is active (matches CLI serve.ts)', () => {
    const config = { ...defaultConfig(), provider: 'simplefin' as const }

    const env = buildServerEnv(config)

    expect(env.CLAD_PLAID_DB).toBe(config.plaid_db)
    expect(env.CLAD_SIMPLEFIN_DB).toBe(config.simplefin_db)
  })
})
