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
    expect(env.CLAD_GRANT_DB).toBe(config.grant_db)
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
   * D5.3 WS2 S2-S3 (#80) — CLAD_GRANT_DB is forwarded unconditionally, the
   * same way CLAD_SIMPLEFIN_DB/CLAD_PLAID_DB are: it's the path the
   * supervised child's SqliteGrantStore would open IF CLAD_MCP_AUTH=oauth
   * were also set, and that flag is deliberately NOT set by this function
   * (the Wave-6 flip), so forwarding the path unconditionally is inert today
   * and requires no provider gating.
   */
  it('always forwards CLAD_GRANT_DB from config.grant_db, regardless of provider', () => {
    for (const provider of ['dummy', 'plaid', 'simplefin'] as const) {
      const config = { ...defaultConfig(), provider }
      const env = buildServerEnv(config)
      expect(env.CLAD_GRANT_DB).toBe(config.grant_db)
    }
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
   * v0.5.0 regression — the supervised child MUST assert a configured agent
   * identity. Omitting `CLAD_AGENT_ID` made it fall back to `server-core.ts`'s
   * hardcoded `'default-agent'`, which denied every tool call under any policy
   * not defining that exact name (see `config.ts`'s `agent_id` doc comment).
   * Harmless before PR #68 (the child only served `tools/list`), user-facing
   * after it.
   */
  describe('agent identity', () => {
    it('sets CLAD_AGENT_ID from config.agent_id', () => {
      const config = { ...defaultConfig(), provider: 'dummy' as const, agent_id: 'finance-agent' }

      const env = buildServerEnv(config)

      expect(env.CLAD_AGENT_ID).toBe('finance-agent')
    })

    it('a configured agent_id wins over an inherited CLAD_AGENT_ID from process.env', () => {
      // Config beats ambient env deliberately: the inherited value is
      // invisible from inside the app, the configured one is an explicit
      // in-app choice. See the precedence comment in mcp-server-env.ts.
      const prev = process.env.CLAD_AGENT_ID
      process.env.CLAD_AGENT_ID = 'inherited-agent'
      try {
        const config = { ...defaultConfig(), provider: 'dummy' as const, agent_id: 'configured-agent' }

        const env = buildServerEnv(config)

        expect(env.CLAD_AGENT_ID).toBe('configured-agent')
      } finally {
        if (prev === undefined) delete process.env.CLAD_AGENT_ID
        else process.env.CLAD_AGENT_ID = prev
      }
    })

    it('leaves an inherited CLAD_AGENT_ID intact when agent_id is unset (the pre-fix user workaround keeps working)', () => {
      const prev = process.env.CLAD_AGENT_ID
      process.env.CLAD_AGENT_ID = 'inherited-agent'
      try {
        const config = { ...defaultConfig(), provider: 'dummy' as const, agent_id: '' }

        const env = buildServerEnv(config)

        expect(env.CLAD_AGENT_ID).toBe('inherited-agent')
      } finally {
        if (prev === undefined) delete process.env.CLAD_AGENT_ID
        else process.env.CLAD_AGENT_ID = prev
      }
    })

    it('never sets CLAD_AGENT_ID_ARG — the CLI\'s --agent-id still outranks this (stdio/CLI path unchanged)', () => {
      const config = { ...defaultConfig(), provider: 'dummy' as const, agent_id: 'finance-agent' }

      const env = buildServerEnv(config)

      expect(env.CLAD_AGENT_ID_ARG).toBeUndefined()
    })

    it('sets CLAD_AGENT_ID for the http transport too (the path Claude Desktop\'s calls actually take)', () => {
      const config = { ...defaultConfig(), provider: 'simplefin' as const, agent_id: 'analyst' }

      const env = buildServerEnv(config, { simplefin: { passphrase: 'p' } }, { transport: 'http', httpPort: 51234 })

      expect(env.CLAD_AGENT_ID).toBe('analyst')
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

  /**
   * D5.3 Wave 6 — THE FLAG FLIP. `CLAD_MCP_AUTH=oauth` is now set
   * unconditionally for the `'http'` transport (the only transport the real
   * caller, `mcp-server-manager.ts`, ever uses), which makes
   * `server-core.ts`'s `loadOAuthResources` a MANDATORY, boot-throwing
   * dependency: it requires `CLAD_GRANT_DB` (already forwarded
   * unconditionally — see 'always forwards CLAD_GRANT_DB' above) AND
   * `CLAD_TOKEN_PASSPHRASE`, for EVERY provider including 'dummy' (which
   * needs no passphrase for its own provider construction). The env-invariant
   * test below is the one that would have caught the v0.5.0-style regression
   * this flip risks repeating: it asserts a REAL `buildServerEnv` call's
   * output — the exact object `mcp-server-manager.ts` hands to `spawn()` —
   * contains every variable `loadOAuthResources`/`loadServerResources`
   * (`server-core.ts`) read at boot, for the 'dummy' provider specifically
   * (the case with no other secret path to accidentally carry the
   * passphrase along for free).
   */
  describe('D5.3 Wave 6 — the flag flip (CLAD_MCP_AUTH)', () => {
    it('sets CLAD_MCP_AUTH=oauth for the http transport', () => {
      const config = { ...defaultConfig(), provider: 'dummy' as const }

      const env = buildServerEnv(config, { oauthPassphrase: 'p' }, { transport: 'http', httpPort: 8765 })

      expect(env.CLAD_MCP_AUTH).toBe('oauth')
    })

    it('does NOT set CLAD_MCP_AUTH by default (no transportOpts) or for stdio — only the real http-spawning caller opts in', () => {
      const config = { ...defaultConfig(), provider: 'dummy' as const }

      expect(buildServerEnv(config).CLAD_MCP_AUTH).toBeUndefined()
      expect(buildServerEnv(config, undefined, { transport: 'stdio' }).CLAD_MCP_AUTH).toBeUndefined()
    })

    it('ALWAYS wins over an inherited CLAD_MCP_AUTH from process.env for the http transport (config-beats-inherited-env, same precedent as CLAD_AGENT_ID)', () => {
      const prev = process.env.CLAD_MCP_AUTH
      process.env.CLAD_MCP_AUTH = 'off'
      try {
        const config = { ...defaultConfig(), provider: 'dummy' as const }

        const env = buildServerEnv(config, { oauthPassphrase: 'p' }, { transport: 'http', httpPort: 8765 })

        expect(env.CLAD_MCP_AUTH).toBe('oauth')
      } finally {
        if (prev === undefined) delete process.env.CLAD_MCP_AUTH
        else process.env.CLAD_MCP_AUTH = prev
      }
    })

    it('sets CLAD_TOKEN_PASSPHRASE from secrets.oauthPassphrase for the DUMMY provider on the http transport (the gap plaid/simplefin secrets never covered)', () => {
      const config = { ...defaultConfig(), provider: 'dummy' as const }

      const env = buildServerEnv(config, { oauthPassphrase: 'grant-store-p' }, { transport: 'http', httpPort: 8765 })

      expect(env.CLAD_TOKEN_PASSPHRASE).toBe('grant-store-p')
    })

    it('omits CLAD_TOKEN_PASSPHRASE for the http transport when no oauthPassphrase (or provider secret) is supplied — defensive, callers should pre-flight this', () => {
      const config = { ...defaultConfig(), provider: 'dummy' as const }

      const env = buildServerEnv(config, undefined, { transport: 'http', httpPort: 8765 })

      expect(env.CLAD_TOKEN_PASSPHRASE).toBeUndefined()
    })

    it("a matching provider secret's passphrase (plaid/simplefin) still wins CLAD_TOKEN_PASSPHRASE over oauthPassphrase when both are supplied — same value in practice, belt-and-suspenders precedence", () => {
      const config = { ...defaultConfig(), provider: 'simplefin' as const }

      const env = buildServerEnv(
        config,
        { oauthPassphrase: 'p', simplefin: { passphrase: 'p' } },
        { transport: 'http', httpPort: 8765 }
      )

      expect(env.CLAD_TOKEN_PASSPHRASE).toBe('p')
    })

    /**
     * THE env-invariant test (task item 1): a REAL `buildServerEnv` call for
     * the 'dummy' provider — the case with no other reason to carry a
     * passphrase — over the 'http' transport must produce an env object
     * containing every variable `loadOAuthResources`/`loadServerResources`
     * read at boot. Fails loudly (a missing/undefined assertion) if any of
     * these regress, rather than only surfacing as a live child boot-throw
     * that a v0.5.0-style QA gap could miss.
     */
    it('the flag-on child env from a real buildServerEnv call contains everything loadOAuthResources/boot requires (dummy provider)', () => {
      const config: CladConfig = {
        ...defaultConfig(),
        provider: 'dummy',
        agent_id: 'analyst',
      }

      const env = buildServerEnv(config, { oauthPassphrase: 'grant-store-passphrase' }, {
        transport: 'http',
        httpPort: 8765,
      })

      // server-core.ts's loadOAuthResources boot-throw requires exactly these two:
      expect(env.CLAD_MCP_AUTH).toBe('oauth')
      expect(env.CLAD_GRANT_DB).toBe(config.grant_db)
      expect(env.CLAD_TOKEN_PASSPHRASE).toBe('grant-store-passphrase')
      // loadServerResources' other boot-time reads (policy path, provider,
      // audit/approval DB paths) — unaffected by the flag, but a boot-throw
      // upstream of loadOAuthResources would mask an env gap here too, so
      // pin them in the SAME test as the flag-on invariants.
      expect(env.CLAD_POLICY_PATH).toBe(config.policy_path)
      expect(env.CLAD_AUDIT_DB).toBe(config.audit_db)
      expect(env.CLAD_APPROVAL_DB).toBe(config.approval_db)
      expect(env.CLAD_PROVIDER).toBe('dummy')
      // Runtime dependency after boot (provider-factory.ts's real-provider
      // gate reads CLAD_MCP_TRANSPORT too; 'dummy' itself needs no secret).
      expect(env.CLAD_MCP_TRANSPORT).toBe('http')
      expect(env.CLAD_MCP_HTTP_PORT).toBe('8765')
      // Per-request identity fallback (server-core.ts's resolvePrincipal) —
      // still forwarded even though Wave 6 makes it vestigial for THIS
      // transport (see mcp-server-manager.ts's doc comment); asserted here
      // so a regression in the unrelated agent_id assignment can't silently
      // hide behind this test's "everything's here" framing.
      expect(env.CLAD_AGENT_ID).toBe('analyst')
    })
  })
})
