import { describe, it, expect } from 'vitest'
import { buildServerEnv } from '../src/main/lib/mcp-server-env.js'
import { defaultConfig, effectivePlaidDbPath } from '../src/main/lib/config.js'

describe('buildServerEnv', () => {
  it('sets the non-secret config paths and ELECTRON_RUN_AS_NODE for the dummy provider', () => {
    // defaultConfig() defaults plaid_env to 'sandbox', so CLAD_PLAID_DB is
    // expected to be the sandbox-derived sibling path, not the raw
    // config.plaid_db field — see the 'env scoping' describe block below.
    const config = { ...defaultConfig(), provider: 'dummy' as const }

    const env = buildServerEnv(config)

    expect(env.CLAD_POLICY_PATH).toBe(config.policy_path)
    expect(env.CLAD_AUDIT_DB).toBe(config.audit_db)
    expect(env.CLAD_APPROVAL_DB).toBe(config.approval_db)
    expect(env.CLAD_PROVIDER).toBe('dummy')
    expect(env.CLAD_PLAID_DB).toBe(effectivePlaidDbPath(config, config.plaid_env))
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('never sets PLAID_* or CLAD_TOKEN_PASSPHRASE for the dummy provider, even if secrets are (mistakenly) passed', () => {
    const config = { ...defaultConfig(), provider: 'dummy' as const }

    const env = buildServerEnv(config, {
      clientId: 'client-123',
      secret: 'shh-secret',
      passphrase: 'the-passphrase',
    })

    expect(env.PLAID_CLIENT_ID).toBeUndefined()
    expect(env.PLAID_SECRET).toBeUndefined()
    expect(env.PLAID_ENV).toBeUndefined()
    expect(env.CLAD_TOKEN_PASSPHRASE).toBeUndefined()
  })

  it('sets PLAID_* and CLAD_TOKEN_PASSPHRASE for the plaid provider when secrets are supplied', () => {
    const config = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'production' as const }

    const env = buildServerEnv(config, {
      clientId: 'client-123',
      secret: 'shh-secret',
      passphrase: 'the-passphrase',
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

  /**
   * D3.3 — the spawned MCP server child must open the SAME env-scoped SQLite
   * file the desktop app itself uses (`config` here is always expected to
   * already be the *effective* config — see `main/index.ts`'s
   * `loadEffectiveConfig`), so `PLAID_ENV` and `CLAD_PLAID_DB` never disagree.
   */
  describe('env scoping', () => {
    it('production resolves CLAD_PLAID_DB to config.plaid_db verbatim (CLI interop)', () => {
      const config = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'production' as const }

      const env = buildServerEnv(config, { clientId: 'a', secret: 'b', passphrase: 'p' })

      expect(env.CLAD_PLAID_DB).toBe(config.plaid_db)
    })

    it('sandbox resolves CLAD_PLAID_DB to the derived -sandbox sibling path, not config.plaid_db', () => {
      const config = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'sandbox' as const }

      const env = buildServerEnv(config, { clientId: 'a', secret: 'b', passphrase: 'p' })

      expect(env.CLAD_PLAID_DB).not.toBe(config.plaid_db)
      expect(env.CLAD_PLAID_DB).toBe(effectivePlaidDbPath(config, 'sandbox'))
      expect(env.CLAD_PLAID_DB?.endsWith('-sandbox.sqlite')).toBe(true)
    })

    it('CLAD_PLAID_DB always agrees with PLAID_ENV for the same config', () => {
      const sandboxConfig = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'sandbox' as const }
      const productionConfig = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'production' as const }

      const sandboxEnv = buildServerEnv(sandboxConfig, { clientId: 'a', secret: 'b', passphrase: 'p' })
      const productionEnv = buildServerEnv(productionConfig, { clientId: 'a', secret: 'b', passphrase: 'p' })

      expect(sandboxEnv.PLAID_ENV).toBe('sandbox')
      expect(sandboxEnv.CLAD_PLAID_DB).toBe(effectivePlaidDbPath(sandboxConfig, 'sandbox'))
      expect(productionEnv.PLAID_ENV).toBe('production')
      expect(productionEnv.CLAD_PLAID_DB).toBe(effectivePlaidDbPath(productionConfig, 'production'))
    })
  })
})
