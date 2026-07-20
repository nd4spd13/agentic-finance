/**
 * `SqliteGrantStore` — the encrypted at-rest home for OAuth state: registered
 * clients (RFC 7591 DCR), consented grants (the immutable client->profile
 * binding + minted scope), short-lived PKCE auth codes, and issued access /
 * refresh tokens (as DPoP-thumbprint-carrying rows).
 *
 * Sibling to `token-store.ts`, and reuses its **exact** security primitives —
 * AES-256-GCM (`crypto.ts`), scrypt-derived per-file key with a key-check seal
 * (`key-meta.ts`), 0600 file mode (`file-mode.ts`), secret-free error discipline
 * (`token-store-errors.ts` / `redact.ts`). Backed by the same `node:sqlite`
 * `DatabaseSync` handle style as `token-store.ts` and `audit/logger.ts`.
 *
 * What is a lookup key vs. what is protected (mirrors "encrypt the secret,
 * index the id" from `token-store.ts`, but stronger for opaque tokens):
 *  - **Access / refresh tokens and auth codes are stored as SHA-256 hashes
 *    only** — the raw value never enters the store on insert and is never
 *    recoverable. We only ever *compare* an incoming token, never *return* it
 *    (unlike provider tokens in `token-store.ts`, which must be handed back),
 *    so hashing is both simpler and strictly safer than encrypt-then-return.
 *  - **Client secret and `clientName`** are AES-256-GCM encrypted at rest
 *    (the secret is confidential; `clientName` is untrusted free text / PII).
 *  - **Lookup / display keys (not secret):** token hash, code hash, `grantId`,
 *    `clientId`, `jkt` (a public-key thumbprint), scopes, timestamps,
 *    `codeChallenge` (a public PKCE value), assurance metadata.
 *  - The `meta` row (salt + key-check) via `openDatabaseKey` gates the whole
 *    file behind the passphrase, on top of the 0600 mode.
 *
 * Security invariants (identical spirit to `token-store.ts:21-27`):
 *  - `enforceFileMode` before key derivation and again after the first write.
 *  - No token, passphrase, key, raw code, or client secret is interpolated into
 *    any thrown message; there are zero `console.*` calls. Any derived
 *    diagnostic is passed through `redactSecrets` before it can escape.
 *  - `listGrants()`/`GrantMeta` select display columns only — never the client
 *    secret or any token/code hash.
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { redactSecrets } from './redact.js'
import { encrypt, decrypt, type EncryptedPayload } from './crypto.js'
import { openDatabaseKey } from './key-meta.js'
import { enforceFileMode } from './file-mode.js'
import type { GrantMeta } from './grant-store.types.js'

export interface GrantStoreOptions {
  dbPath: string
  passphrase: string
}

/** RFC 7591 registered client. The secret (if confidential) is stored encrypted and never returned. */
export interface StoredClient {
  clientId: string
  clientName?: string
  redirectUris: string[]
  tokenEndpointAuthMethod: 'none' | 'client_secret_post'
  // clientSecret stored ENCRYPTED (see RegisterClientInput); never returned in any view.
  clientSecretExpiresAt?: number
  clientIdIssuedAt: number
  /** Binding is set at consent and immutable thereafter (acceptance #1). */
  boundProfileId?: string
  createdAt: string
}

/**
 * Input to {@link GrantStore.registerClient}. Matches `Omit<StoredClient,
 * 'clientId' | 'clientIdIssuedAt' | 'createdAt'>` (those three are server-issued)
 * and additionally accepts the raw `clientSecret` for confidential clients — the
 * secret is stored AES-256-GCM encrypted and is never present on the returned
 * {@link StoredClient}. (WS5 §3's `StoredClient` documents the encrypted secret
 * but omits it from the returned shape; this input type is where it enters.)
 */
export interface RegisterClientInput
  extends Omit<StoredClient, 'clientId' | 'clientIdIssuedAt' | 'createdAt'> {
  /** Raw client secret for `client_secret_post` clients; encrypted at rest, never returned. */
  clientSecret?: string
}

/** A consented authorization: the immutable client->profile binding + minted scope. */
export interface StoredGrant {
  grantId: string
  clientId: string
  /** Server-chosen at consent; never client-supplied. */
  profileId: string
  /** Minted from policy (WS2 §6); stored, not re-derivable if policy later changes. */
  scopes: string[]
  dpopBound: boolean
  /** Trust assurance recorded at consent (WS7 seam); provider-agnostic. */
  assuranceLevel: 'none' | 'local-consent' | 'attested'
  /** Highest scope sensitivity permitted for this client at consent (WS7 seam). */
  maxScopeSensitivity: 'low' | 'high'
  createdAt: string
  /** Updated by `verifyAccessToken` (WS2); powers WS4 "last used". */
  lastUsedAt?: string
  revokedAt?: string
}

/** Short-lived PKCE auth code (single-use, ~60s). The raw `code` is hashed for storage. */
export interface StoredAuthCode {
  /** Raw code on input/output; stored only as its SHA-256 hash and looked up by hash. */
  code: string
  grantId: string
  /** S256 PKCE challenge — a public value, stored plaintext. */
  codeChallenge: string
  redirectUri: string
  expiresAt: number
  /** Set on redeem; a second redeem is rejected (replay defence). */
  consumedAt?: number
}

/** An opaque access or refresh token. Only its SHA-256 hash is persisted — the raw token is never stored. */
export interface StoredToken {
  /** SHA-256 (hex) of the opaque token; the lookup key. */
  tokenHash: string
  kind: 'access' | 'refresh'
  grantId: string
  /** DPoP RFC 7638 thumbprint (public-key hash; M3) -> AuthInfo.extra.jkt. */
  jkt?: string
  expiresAt: number
  createdAt: string
  /** Refresh rotation chain (leak-window bound). */
  rotatedFrom?: string
}

export interface GrantStore {
  // clients (WS2 clientsStore)
  registerClient(c: RegisterClientInput): StoredClient
  getClient(clientId: string): StoredClient | undefined
  bindClientProfile(clientId: string, profileId: string): void // at consent, once
  /**
   * Constant-time verification of a confidential client's secret at `/token`
   * (D5.3 WS2 S5 — the "landmine #1" secret-verification path). `getClient`
   * deliberately never returns the secret, so the SDK's own
   * `authenticateClient` middleware is a no-op for confidential clients; this
   * method is the real check. The comparison happens ENTIRELY inside the store
   * (the only holder of the AES key) so the plaintext secret never leaves this
   * boundary. Returns `true` iff a secret is on file for `clientId` and
   * `candidate` matches it; `false` for an unknown client, a client with no
   * secret on file, an absent `candidate`, or any mismatch. Public clients
   * (`token_endpoint_auth_method: 'none'`) are authenticated by PKCE alone and
   * must NOT be routed through this method.
   */
  verifyClientSecret(clientId: string, candidate: string | undefined): boolean
  // grants
  createGrant(g: Omit<StoredGrant, 'grantId' | 'createdAt'>): StoredGrant
  getGrant(grantId: string): StoredGrant | undefined
  listGrants(): GrantMeta[] // WS4: display-safe, no secrets
  touchGrant(grantId: string, at: string): void // lastUsedAt
  revokeGrant(grantId: string): void // cascade: delete tokens + codes
  // auth codes
  putAuthCode(a: StoredAuthCode): void
  consumeAuthCode(code: string): StoredAuthCode | undefined // single-use
  /**
   * Non-consuming peek at a stored auth code by its raw value (D5.3 WS2 S5).
   * Returns the code's public metadata (crucially its S256 `codeChallenge`)
   * WITHOUT marking it consumed, so `CladOAuthProvider.challengeForAuthorizationCode`
   * can hand the challenge to the SDK's PKCE verifier while `consumeAuthCode`
   * remains the SOLE single-use gate (called later, in
   * `exchangeAuthorizationCode`). Returns `undefined` only when no row exists;
   * expiry / already-consumed are NOT filtered here — that is
   * `consumeAuthCode`'s job, so a replay of a consumed code still fails there.
   */
  getAuthCode(code: string): StoredAuthCode | undefined
  // tokens
  putToken(t: StoredToken): void
  getToken(rawToken: string): StoredToken | undefined // hashes then looks up; filters expired
  deleteToken(rawToken: string): void
  rotateRefresh(oldRaw: string, next: StoredToken): void // atomic delete-old + insert-new
  // maintenance
  purgeExpired(now: number): void
  close(): void
}

interface EncColumns {
  ciphertext: Uint8Array | null
  iv: Uint8Array | null
  auth_tag: Uint8Array | null
}

interface ClientRow {
  client_id: string
  client_name_ciphertext: Uint8Array | null
  client_name_iv: Uint8Array | null
  client_name_auth_tag: Uint8Array | null
  redirect_uris: string
  token_endpoint_auth_method: string
  client_secret_expires_at: number | null
  client_id_issued_at: number
  bound_profile_id: string | null
  created_at: string
}

interface GrantRow {
  grant_id: string
  client_id: string
  profile_id: string
  scopes: string
  dpop_bound: number
  assurance_level: string
  max_scope_sensitivity: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

interface GrantMetaRow extends GrantRow {
  client_name_ciphertext: Uint8Array | null
  client_name_iv: Uint8Array | null
  client_name_auth_tag: Uint8Array | null
}

interface AuthCodeRow {
  code_hash: string
  grant_id: string
  code_challenge: string
  redirect_uri: string
  expires_at: number
  consumed_at: number | null
}

interface TokenRow {
  token_hash: string
  kind: string
  grant_id: string
  jkt: string | null
  expires_at: number
  created_at: string
  rotated_from: string | null
}

export class SqliteGrantStore implements GrantStore {
  private readonly db: DatabaseSync
  private readonly dbPath: string
  private readonly key: Buffer

  constructor(options: GrantStoreOptions) {
    this.dbPath = options.dbPath
    this.db = new DatabaseSync(options.dbPath)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        client_name_ciphertext BLOB,
        client_name_iv BLOB,
        client_name_auth_tag BLOB,
        redirect_uris TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        client_secret_ciphertext BLOB,
        client_secret_iv BLOB,
        client_secret_auth_tag BLOB,
        client_secret_expires_at INTEGER,
        client_id_issued_at INTEGER NOT NULL,
        bound_profile_id TEXT,
        created_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        dpop_bound INTEGER NOT NULL,
        assurance_level TEXT NOT NULL,
        max_scope_sensitivity TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_codes (
        code_hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        jkt TEXT,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        rotated_from TEXT
      )
    `)

    // Owner-only before deriving keys or touching secrets, and again after the
    // first write may have created the file. `openDatabaseKey` creates/verifies
    // the `meta` table and throws `TokenStoreKeyError` on a wrong passphrase.
    enforceFileMode(this.dbPath)
    this.key = openDatabaseKey(this.db, options.passphrase)
    enforceFileMode(this.dbPath)
  }

  // ---- clients ----------------------------------------------------------

  registerClient(c: RegisterClientInput): StoredClient {
    const clientId = randomUUID()
    const clientIdIssuedAt = Math.floor(Date.now() / 1000)
    const createdAt = new Date().toISOString()

    const name = this.encryptOrNull(c.clientName)
    const secret = this.encryptOrNull(c.clientSecret)

    this.db
      .prepare(
        `INSERT INTO clients (
           client_id, client_name_ciphertext, client_name_iv, client_name_auth_tag,
           redirect_uris, token_endpoint_auth_method,
           client_secret_ciphertext, client_secret_iv, client_secret_auth_tag,
           client_secret_expires_at, client_id_issued_at, bound_profile_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        clientId,
        name.ciphertext,
        name.iv,
        name.auth_tag,
        JSON.stringify(c.redirectUris),
        c.tokenEndpointAuthMethod,
        secret.ciphertext,
        secret.iv,
        secret.auth_tag,
        c.clientSecretExpiresAt ?? null,
        clientIdIssuedAt,
        c.boundProfileId ?? null,
        createdAt
      )

    return {
      clientId,
      clientName: c.clientName,
      redirectUris: c.redirectUris,
      tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
      clientSecretExpiresAt: c.clientSecretExpiresAt,
      clientIdIssuedAt,
      boundProfileId: c.boundProfileId,
      createdAt,
    }
  }

  getClient(clientId: string): StoredClient | undefined {
    // Deliberately does NOT select the client_secret columns — the secret is
    // write-only from this store's perspective (a future WS2 verify path owns
    // any comparison), keeping it out of memory on ordinary reads.
    const row = this.db
      .prepare(
        `SELECT client_id, client_name_ciphertext, client_name_iv, client_name_auth_tag,
                redirect_uris, token_endpoint_auth_method, client_secret_expires_at,
                client_id_issued_at, bound_profile_id, created_at
           FROM clients WHERE client_id = ?`
      )
      .get(clientId) as ClientRow | undefined

    if (row === undefined) return undefined

    return {
      clientId: row.client_id,
      clientName: this.decryptOrUndefined({
        ciphertext: row.client_name_ciphertext,
        iv: row.client_name_iv,
        auth_tag: row.client_name_auth_tag,
      }),
      redirectUris: JSON.parse(row.redirect_uris) as string[],
      tokenEndpointAuthMethod: row.token_endpoint_auth_method as StoredClient['tokenEndpointAuthMethod'],
      clientSecretExpiresAt: row.client_secret_expires_at ?? undefined,
      clientIdIssuedAt: row.client_id_issued_at,
      boundProfileId: row.bound_profile_id ?? undefined,
      createdAt: row.created_at,
    }
  }

  bindClientProfile(clientId: string, profileId: string): void {
    const row = this.db
      .prepare('SELECT bound_profile_id FROM clients WHERE client_id = ?')
      .get(clientId) as { bound_profile_id: string | null } | undefined

    if (row === undefined) {
      // clientId is not secret, but redact defensively per the module contract.
      throw new Error(redactSecrets('Cannot bind profile: unknown client.'))
    }
    if (row.bound_profile_id !== null && row.bound_profile_id !== profileId) {
      // Set-once immutability (acceptance #1): re-binding to a different profile
      // is rejected. No secret material — and no profile id — is interpolated.
      throw new Error(
        redactSecrets(
          'Client profile binding is immutable and is already set to a different profile.'
        )
      )
    }
    this.db
      .prepare('UPDATE clients SET bound_profile_id = ? WHERE client_id = ?')
      .run(profileId, clientId)
  }

  verifyClientSecret(clientId: string, candidate: string | undefined): boolean {
    // Fail closed on a missing candidate before touching the store.
    if (candidate === undefined) return false

    const row = this.db
      .prepare(
        `SELECT client_secret_ciphertext, client_secret_iv, client_secret_auth_tag
           FROM clients WHERE client_id = ?`
      )
      .get(clientId) as
      | {
          client_secret_ciphertext: Uint8Array | null
          client_secret_iv: Uint8Array | null
          client_secret_auth_tag: Uint8Array | null
        }
      | undefined

    if (row === undefined) return false

    const stored = this.decryptOrUndefined({
      ciphertext: row.client_secret_ciphertext,
      iv: row.client_secret_iv,
      auth_tag: row.client_secret_auth_tag,
    })
    // No secret on file: a public client must be authenticated by PKCE, never
    // routed here — refuse rather than silently accept.
    if (stored === undefined) return false

    // Constant-time compare over fixed-length SHA-256 digests, so neither the
    // secret's length nor its content leaks through comparison timing. The
    // plaintext secret never leaves this method.
    const a = createHash('sha256').update(stored, 'utf8').digest()
    const b = createHash('sha256').update(candidate, 'utf8').digest()
    return timingSafeEqual(a, b)
  }

  // ---- grants -----------------------------------------------------------

  createGrant(g: Omit<StoredGrant, 'grantId' | 'createdAt'>): StoredGrant {
    const grantId = randomUUID()
    const createdAt = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO grants (
           grant_id, client_id, profile_id, scopes, dpop_bound,
           assurance_level, max_scope_sensitivity, created_at, last_used_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        grantId,
        g.clientId,
        g.profileId,
        JSON.stringify(g.scopes),
        g.dpopBound ? 1 : 0,
        g.assuranceLevel,
        g.maxScopeSensitivity,
        createdAt,
        g.lastUsedAt ?? null,
        g.revokedAt ?? null
      )

    return { ...g, grantId, createdAt }
  }

  getGrant(grantId: string): StoredGrant | undefined {
    const row = this.db.prepare('SELECT * FROM grants WHERE grant_id = ?').get(grantId) as
      | GrantRow
      | undefined
    if (row === undefined) return undefined
    return this.toGrant(row)
  }

  listGrants(): GrantMeta[] {
    // Display columns only: joins `clients` for the (encrypted, display-safe)
    // clientName but never selects the client secret or any token/code hash.
    const rows = this.db
      .prepare(
        `SELECT g.grant_id, g.client_id, g.profile_id, g.scopes, g.dpop_bound,
                g.assurance_level, g.max_scope_sensitivity, g.created_at,
                g.last_used_at, g.revoked_at,
                c.client_name_ciphertext, c.client_name_iv, c.client_name_auth_tag
           FROM grants g
           LEFT JOIN clients c ON c.client_id = g.client_id
          ORDER BY g.created_at ASC`
      )
      .all() as unknown as GrantMetaRow[]

    return rows.map((row) => ({
      grantId: row.grant_id,
      clientId: row.client_id,
      clientName: this.decryptOrUndefined({
        ciphertext: row.client_name_ciphertext,
        iv: row.client_name_iv,
        auth_tag: row.client_name_auth_tag,
      }),
      profileId: row.profile_id,
      scopes: JSON.parse(row.scopes) as string[],
      dpopBound: row.dpop_bound === 1,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
      revoked: row.revoked_at !== null,
      assuranceLevel: row.assurance_level as GrantMeta['assuranceLevel'],
      maxScopeSensitivity: row.max_scope_sensitivity as GrantMeta['maxScopeSensitivity'],
    }))
  }

  touchGrant(grantId: string, at: string): void {
    this.db.prepare('UPDATE grants SET last_used_at = ? WHERE grant_id = ?').run(at, grantId)
  }

  revokeGrant(grantId: string): void {
    const now = new Date().toISOString()
    // Mark the grant revoked (kept for WS4's list) and cascade-delete its live
    // credentials, so the next `getToken`/`verifyAccessToken` fails closed.
    this.tx(() => {
      this.db.prepare('UPDATE grants SET revoked_at = ? WHERE grant_id = ?').run(now, grantId)
      this.db.prepare('DELETE FROM tokens WHERE grant_id = ?').run(grantId)
      this.db.prepare('DELETE FROM auth_codes WHERE grant_id = ?').run(grantId)
    })
  }

  // ---- auth codes -------------------------------------------------------

  putAuthCode(a: StoredAuthCode): void {
    // Store only the hash of the raw code; the raw value never lands on disk.
    this.db
      .prepare(
        `INSERT INTO auth_codes (code_hash, grant_id, code_challenge, redirect_uri, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.hash(a.code),
        a.grantId,
        a.codeChallenge,
        a.redirectUri,
        a.expiresAt,
        a.consumedAt ?? null
      )
  }

  getAuthCode(code: string): StoredAuthCode | undefined {
    // Pure, non-consuming peek — never marks `consumed_at`. Returns the row's
    // public metadata as-is (including a possibly-consumed / expired code), so
    // `consumeAuthCode` stays the single-use gate. Echoes the caller-supplied
    // raw `code` back; the hash is never returned.
    const row = this.db
      .prepare('SELECT * FROM auth_codes WHERE code_hash = ?')
      .get(this.hash(code)) as AuthCodeRow | undefined
    if (row === undefined) return undefined
    return {
      code,
      grantId: row.grant_id,
      codeChallenge: row.code_challenge,
      redirectUri: row.redirect_uri,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at ?? undefined,
    }
  }

  consumeAuthCode(code: string): StoredAuthCode | undefined {
    const codeHash = this.hash(code)
    const now = Date.now()

    // Single-use: return only a code that is unconsumed AND unexpired, and mark
    // it consumed in the same read so a replay finds `consumed_at` already set.
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT * FROM auth_codes WHERE code_hash = ?')
        .get(codeHash) as AuthCodeRow | undefined

      if (row === undefined || row.consumed_at !== null || row.expires_at <= now) {
        return undefined
      }

      this.db.prepare('UPDATE auth_codes SET consumed_at = ? WHERE code_hash = ?').run(now, codeHash)

      // Echo the caller-supplied raw code back (it already holds it); never the hash.
      return {
        code,
        grantId: row.grant_id,
        codeChallenge: row.code_challenge,
        redirectUri: row.redirect_uri,
        expiresAt: row.expires_at,
        consumedAt: now,
      }
    })
  }

  // ---- tokens -----------------------------------------------------------

  putToken(t: StoredToken): void {
    // `t.tokenHash` is already the SHA-256 hash — the raw token never reaches
    // this store on insert, which is the strongest form of "never store raw".
    this.insertToken(t)
  }

  getToken(rawToken: string): StoredToken | undefined {
    const now = Date.now()
    const row = this.db
      .prepare('SELECT * FROM tokens WHERE token_hash = ? AND expires_at > ?')
      .get(this.hash(rawToken), now) as TokenRow | undefined
    if (row === undefined) return undefined
    return this.toToken(row)
  }

  deleteToken(rawToken: string): void {
    this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(this.hash(rawToken))
  }

  rotateRefresh(oldRaw: string, next: StoredToken): void {
    // Atomic: the old refresh is invalidated and the new one issued together,
    // bounding the leak window (a partially-applied rotation can't leave both live).
    this.tx(() => {
      this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(this.hash(oldRaw))
      this.insertToken(next)
    })
  }

  // ---- maintenance ------------------------------------------------------

  purgeExpired(now: number): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM tokens WHERE expires_at <= ?').run(now)
      this.db.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').run(now)
    })
  }

  close(): void {
    this.db.close()
  }

  // ---- internals --------------------------------------------------------

  private insertToken(t: StoredToken): void {
    this.db
      .prepare(
        `INSERT INTO tokens (token_hash, kind, grant_id, jkt, expires_at, created_at, rotated_from)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(t.tokenHash, t.kind, t.grantId, t.jkt ?? null, t.expiresAt, t.createdAt, t.rotatedFrom ?? null)
  }

  private toGrant(row: GrantRow): StoredGrant {
    return {
      grantId: row.grant_id,
      clientId: row.client_id,
      profileId: row.profile_id,
      scopes: JSON.parse(row.scopes) as string[],
      dpopBound: row.dpop_bound === 1,
      assuranceLevel: row.assurance_level as StoredGrant['assuranceLevel'],
      maxScopeSensitivity: row.max_scope_sensitivity as StoredGrant['maxScopeSensitivity'],
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
      revokedAt: row.revoked_at ?? undefined,
    }
  }

  private toToken(row: TokenRow): StoredToken {
    return {
      tokenHash: row.token_hash,
      kind: row.kind as StoredToken['kind'],
      grantId: row.grant_id,
      jkt: row.jkt ?? undefined,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      rotatedFrom: row.rotated_from ?? undefined,
    }
  }

  /** SHA-256 hex of an opaque token or auth code — the only representation stored. */
  private hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex')
  }

  private encryptOrNull(plaintext: string | undefined): EncColumns {
    if (plaintext === undefined) {
      return { ciphertext: null, iv: null, auth_tag: null }
    }
    const p: EncryptedPayload = encrypt(this.key, plaintext)
    return { ciphertext: p.ciphertext, iv: p.iv, auth_tag: p.authTag }
  }

  private decryptOrUndefined(cols: EncColumns): string | undefined {
    if (cols.ciphertext === null || cols.iv === null || cols.auth_tag === null) {
      return undefined
    }
    return decrypt(this.key, {
      ciphertext: Buffer.from(cols.ciphertext),
      iv: Buffer.from(cols.iv),
      authTag: Buffer.from(cols.auth_tag),
    })
  }

  /** Runs `fn` inside a SQLite transaction, rolling back on any throw. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}
