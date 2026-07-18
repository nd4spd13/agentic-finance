import { describe, it, expect } from 'vitest'
import { buildServerEnv } from '../src/main/lib/mcp-server-env.js'
import { defaultConfig, effectivePlaidDbPath } from '../src/main/lib/config.js'

describe('buildServerEnv', () => {
  it('sets the non-secret config paths (including CLAD_SIMPLEFIN_DB, unconditionally) and ELECTRON_RUN_AS_NODE for the dummy provider', () => {
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

    // The plaid path is the env-scoped effective one (defaultConfig() is
    // sandbox) — see the 'env scoping' describe block below.
    expect(env.CLAD_PLAID_DB).toBe(effectivePlaidDbPath(config, config.plaid_env))
    expect(env.CLAD_SIMPLEFIN_DB).toBe(config.simplefin_db)
  })

  /**
   * D5.3 WS1 — the desktop app's supervised child runs the loopback HTTP
   * transport (`CLAD_MCP_TRANSPORT=http` + `CLAD_MCP_HTTP_PORT`). Default /
   * stdio callers (every existing test above) must get NEITHER var, so the
   * CLI/direct-spawn stdio path is unchanged.
   */
  describe('transport selection', () => {
    it('sets no transport env vars by default (stdio path unchanged)', () => {
      const env = buildServerEnv({ ...defaultConfig(), provider: 'dummy' as const })

      expect(env.CLAD_MCP_TRANSPORT).toBeUndefined()
      expect(env.CLAD_MCP_HTTP_PORT).toBeUndefined()
    })

    it('sets no transport env vars when transport is explicitly stdio', () => {
      const env = buildServerEnv({ ...defaultConfig(), provider: 'dummy' as const }, undefined, {
        transport: 'stdio',
      })

      expect(env.CLAD_MCP_TRANSPORT).toBeUndefined()
      expect(env.CLAD_MCP_HTTP_PORT).toBeUndefined()
    })

    it('sets CLAD_MCP_TRANSPORT=http and CLAD_MCP_HTTP_PORT for the http transport', () => {
      const env = buildServerEnv({ ...defaultConfig(), provider: 'simplefin' as const }, { simplefin: { passphrase: 'p' } }, {
        transport: 'http',
        httpPort: 51234,
      })

      expect(env.CLAD_MCP_TRANSPORT).toBe('http')
      expect(env.CLAD_MCP_HTTP_PORT).toBe('51234')
      // The secret path is unaffected by the transport option.
      expect(env.CLAD_TOKEN_PASSPHRASE).toBe('p')
    })
  })

  /**
   * D3.3 — the spawned MCP server child must open the SAME env-scoped SQLite
   * file the desktop app itself uses (`config` here is always expected to
   * already be the *effective* config — see `main/index.ts`'s
   * `loadEffectiveConfig`), so `PLAID_ENV` and `CLAD_PLAID_DB` never disagree.
   * Secrets use the `McpSpawnSecrets` shape (`{ plaid: {...} }`) — this
   * branch generalized the old flat `PlaidSpawnSecrets` second parameter.
   */
  describe('env scoping', () => {
    it('production resolves CLAD_PLAID_DB to config.plaid_db verbatim (CLI interop)', () => {
      const config = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'production' as const }

      const env = buildServerEnv(config, { plaid: { clientId: 'a', secret: 'b', passphrase: 'p' } })

      expect(env.CLAD_PLAID_DB).toBe(config.plaid_db)
    })

    it('sandbox resolves CLAD_PLAID_DB to the derived -sandbox sibling path, not config.plaid_db', () => {
      const config = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'sandbox' as const }

      const env = buildServerEnv(config, { plaid: { clientId: 'a', secret: 'b', passphrase: 'p' } })

      expect(env.CLAD_PLAID_DB).not.toBe(config.plaid_db)
      expect(env.CLAD_PLAID_DB).toBe(effectivePlaidDbPath(config, 'sandbox'))
      expect(env.CLAD_PLAID_DB?.endsWith('-sandbox.sqlite')).toBe(true)
    })

    it('CLAD_PLAID_DB always agrees with PLAID_ENV for the same config', () => {
      const sandboxConfig = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'sandbox' as const }
      const productionConfig = { ...defaultConfig(), provider: 'plaid' as const, plaid_env: 'production' as const }

      const sandboxEnv = buildServerEnv(sandboxConfig, { plaid: { clientId: 'a', secret: 'b', passphrase: 'p' } })
      const productionEnv = buildServerEnv(productionConfig, { plaid: { clientId: 'a', secret: 'b', passphrase: 'p' } })

      expect(sandboxEnv.PLAID_ENV).toBe('sandbox')
      expect(sandboxEnv.CLAD_PLAID_DB).toBe(effectivePlaidDbPath(sandboxConfig, 'sandbox'))
      expect(productionEnv.PLAID_ENV).toBe('production')
      expect(productionEnv.CLAD_PLAID_DB).toBe(effectivePlaidDbPath(productionConfig, 'production'))
    })
  })
})
