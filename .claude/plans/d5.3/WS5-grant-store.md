# WS5 — Encrypted grant/token store (detailed design)

Parent: [`../D5.3-authenticated-agent-identity-plan.md`](../D5.3-authenticated-agent-identity-plan.md) §3 WS5, §7.5.
Consumed by: [`WS2-oauth-resource-server.md`](WS2-oauth-resource-server.md) (hard predecessor for WS2 S3–S6), [`WS4-consent-revocation-ui.md`](WS4-consent-revocation-ui.md) (revoke + connected-clients list).
Status: **design / implementation-ready.**

The new at-rest home for OAuth state: registered clients, issued grants, access/refresh tokens, and DPoP key thumbprints. It reuses the **exact** AES-256-GCM + scrypt + safeStorage-held-passphrase pattern already proven by `SqliteTokenStore` — same crypto primitives, same key-check discipline, same 0600 file mode, same "no secret ever in a thrown message" rule.

---

## 1. Goal & acceptance advanced

Provide the persistence layer WS2's `CladOAuthProvider` is a thin flow-wrapper over, with the same security guarantees as the existing token store:
- **#2/#3 (bound, replay-resistant tokens):** stores `cnf.jkt` per token and makes revocation a row delete (⇒ WS2's live `verifyAccessToken` lookup rejects the very next request).
- **#1 (no id-spoofing):** persists the immutable **client→profile binding** created at consent, so the profile can never be re-chosen by a later request.
- Standing checklist items 5 (0600) and 6 (no plaintext at-rest secrets).

Milestone mapping: lands early in **M2** (parent §4), before WS2's DCR/authorize/token sub-steps can be wired.

---

## 2. Reuse map (what already exists — do not re-invent)

| Need | Existing, reuse verbatim | Path |
| --- | --- | --- |
| AES-256-GCM encrypt/decrypt, fresh IV per call, GCM tamper-fail-closed | `encrypt` / `decrypt` / `EncryptedPayload` | `packages/core/src/security/crypto.ts:66-86` |
| scrypt KDF (N=2¹⁵) | `deriveKey` | `packages/core/src/security/crypto.ts:51-58` |
| Per-file key unlock: `meta` table, salt, key-check seal, `TokenStoreKeyError` on mismatch | `openDatabaseKey` | `packages/core/src/security/key-meta.ts:62-83` |
| 0600 enforcement on create + reopen | `enforceFileMode` | `packages/core/src/security/file-mode.ts` (used by `token-store.ts:73,76`) |
| Secret-free error discipline / redaction | `redactSecrets`, `TokenStoreKeyError` | `security/redact.ts`, `security/token-store-errors.ts` |
| safeStorage-sealed passphrase custody (desktop) | `PassphraseCustody` | `packages/desktop/src/main/lib/passphrase.ts:74` |

**Key decision — share the passphrase, separate the file.** `key-meta.ts` is explicitly designed so multiple modules can share one passphrase across *different* SQLite files (its doc, `:5-13`). The grant store gets its **own file** (`grants.sqlite`), unlocked with the **same** token-store passphrase the desktop app already holds unlocked (`passphrase.ts`). Rationale: (a) grants are a distinct concern from provider credentials — different lifecycle, different UI (WS4 vs Connect screen); (b) reusing the passphrase means **zero new key-custody surface** — no second safeStorage seal, no second CLI-migration story, and the D4.3 unsigned-rebuild degradation is already handled by `PassphraseCustody.probeCustody()`. Do **not** co-locate grants in `plaid.sqlite`/`simplefin.sqlite` (those are provider-scoped and may not exist for a dummy user).

---

## 3. File-level changes

### New: `packages/core/src/security/grant-store.ts` (sibling to `token-store.ts`)

Mirrors `SqliteTokenStore`'s structure (`token-store.ts:48-155`): `DatabaseSync`, `enforceFileMode` → `openDatabaseKey` → `enforceFileMode`, encrypt-on-write / decrypt-on-read, metadata-only list methods.

```ts
export interface GrantStoreOptions { dbPath: string; passphrase: string }

/** RFC 7591 registered client. Secret (if confidential) is the only encrypted column. */
export interface StoredClient {
  clientId: string
  clientName?: string
  redirectUris: string[]
  tokenEndpointAuthMethod: 'none' | 'client_secret_post'
  // clientSecret stored ENCRYPTED; never returned in list views
  clientSecretExpiresAt?: number
  clientIdIssuedAt: number
  // Binding is set at consent, immutable thereafter (acceptance #1):
  boundProfileId?: string
  createdAt: string
}

/** A consented authorization: the immutable client->profile binding + minted scope. */
export interface StoredGrant {
  grantId: string
  clientId: string
  profileId: string            // server-chosen at consent; never client-supplied
  scopes: string[]             // minted from policy (WS2 §6); stored, not re-derivable if policy changes
  dpopBound: boolean
  createdAt: string
  lastUsedAt?: string          // updated by verifyAccessToken; powers WS4 "last used" (also cross-checked vs audit)
  revokedAt?: string
}

/** Short-lived PKCE auth code (single-use, ~60s). */
export interface StoredAuthCode {
  code: string                 // stored hashed (SHA-256), looked up by hash
  grantId: string
  codeChallenge: string        // S256 challenge
  redirectUri: string
  expiresAt: number
  consumedAt?: number          // set on redeem -> replay rejected
}

/** Opaque access or refresh token. `tokenHash` is the lookup key; the raw token is never stored. */
export interface StoredToken {
  tokenHash: string            // SHA-256 of the opaque token
  kind: 'access' | 'refresh'
  grantId: string
  jkt?: string                 // DPoP thumbprint (public-key hash; M3) -> AuthInfo.extra.jkt
  expiresAt: number
  createdAt: string
  rotatedFrom?: string         // refresh rotation chain (leak-window bound)
}

export interface GrantStore {
  // clients (WS2 clientsStore)
  registerClient(c: Omit<StoredClient,'clientId'|'clientIdIssuedAt'|'createdAt'>): StoredClient
  getClient(clientId: string): StoredClient | undefined
  bindClientProfile(clientId: string, profileId: string): void      // at consent, once
  // grants
  createGrant(g: Omit<StoredGrant,'grantId'|'createdAt'>): StoredGrant
  getGrant(grantId: string): StoredGrant | undefined
  listGrants(): GrantMeta[]                                         // WS4: display-safe, no secrets
  touchGrant(grantId: string, at: string): void                    // lastUsedAt
  revokeGrant(grantId: string): void                               // cascade: delete tokens + codes
  // auth codes
  putAuthCode(a: StoredAuthCode): void
  consumeAuthCode(code: string): StoredAuthCode | undefined        // single-use; marks consumed / returns undefined if already used/expired
  // tokens
  putToken(t: StoredToken): void
  getToken(rawToken: string): StoredToken | undefined              // hashes then looks up; filters expired
  deleteToken(rawToken: string): void
  rotateRefresh(oldRaw: string, next: StoredToken): void           // atomic delete-old + insert-new
  // maintenance
  purgeExpired(now: number): void
  close(): void
}
```

**What is encrypted vs. what is a lookup key (mirrors `token-store.ts`'s "encrypt the secret, index the id"):**
- **Encrypted columns (AES-256-GCM):** client secret, refresh token *material if any secondary secret is kept*, and any free-text (`clientName`) that could carry PII. Access/refresh tokens themselves are **not stored in plaintext or ciphertext — only their SHA-256 hash**, exactly like a password store: a stolen `grants.sqlite` yields no usable token even before considering encryption. (This is *stronger* than `token-store.ts`, which must be able to *return* the provider token; OAuth tokens we only ever *compare*, so we hash.)
- **Lookup keys (not secret):** `tokenHash`, `code` hash, `grantId`, `clientId`, `jkt` (a public-key thumbprint), scopes, timestamps.
- **The `meta` row** (salt + key-check) via `openDatabaseKey` gates the whole file; even the non-secret columns sit behind the 0600 + key-check file.

### New: `packages/core/src/security/grant-store.types.ts`
Display-safe `GrantMeta` (for WS4/IPC) with **no** secret/hash fields:
```ts
export interface GrantMeta {
  grantId: string
  clientId: string
  clientName?: string
  profileId: string
  scopes: string[]
  dpopBound: boolean
  createdAt: string
  lastUsedAt?: string
  revoked: boolean
}
```

### Modified
- `packages/core/src/index.ts` — export `GrantStore`, `SqliteGrantStore`, `GrantMeta`, and reuse-shared `TokenStoreKeyError` (already exported).
- `packages/mcp-server/src/oauth/provider.ts` (WS2) — `CladOAuthProvider` composes `GrantStore`.
- **Desktop wiring (WS4):** `packages/desktop/src/main/index.ts` constructs the singleton `SqliteGrantStore({ dbPath: grantsDbPath, passphrase })` using the **already-resolved** token-store passphrase (from `PassphraseCustody.getOrCreate()`, `passphrase.ts:124`) — no new custody. `grantsDbPath` is a sibling of the provider DBs under the user-data dir (a new `grant_db` config field, defaulting to `~/.clad/grants.sqlite`).

---

## 4. Crypto & file discipline (copy the invariants exactly)

From `token-store.ts` (`:53-77`) and its module doc (`:21-27`):
1. `enforceFileMode(dbPath)` **before** deriving keys, and again after first write (`:73,76`).
2. `openDatabaseKey(db, passphrase)` — creates/verifies `meta`, returns the 32-byte key or throws `TokenStoreKeyError` (secret-free) on mismatch (`key-meta.ts:62-83`).
3. **No** token/passphrase/key/raw-code ever interpolated into a thrown message, and zero `console.*`. Any diagnostic derived from stored data goes through `redactSecrets` (`token-store.ts:112`).
4. `listGrants()`/`GrantMeta` select **metadata columns only** — never token/secret columns (the `token-store.ts:118-138` `listItems` pattern: "never reading them keeps plaintext out of memory").
5. Same `node:sqlite` `DatabaseSync` backing as `token-store.ts` and `audit/logger.ts`.

---

## 5. The D4.3 unsigned-rebuild degradation (parent §7.5)

macOS Keychain ACLs bind to the app's code-signing identity, so an unsigned rebuild's `safeStorage` can't decrypt what a previous differently-signed build sealed (`passphrase.ts:44-62`, `PassphraseSource='undecryptable'`). Because the grant store is unlocked by the **same** safeStorage-held passphrase, it inherits **exactly the same** failure and the **same** already-built recovery:

- On launch, `computeMigrationStatus` already probes via `PassphraseCustody.probeCustody()` (`passphrase.ts:101-109`) and surfaces `'passphrase-undecryptable'` through the existing `MigrationStatus`/`MigrationPrompt` path (`shared/ipc.ts:111`). When the passphrase can't be unlocked, the grant store simply isn't opened — WS4's connected-clients UI must **degrade to "re-connect" / empty**, never crash, mirroring how the Connect screen degrades when the token store is `'unavailable'` (`shared/ipc.ts:450` `ProviderConnectionState='unavailable'`).
- Concretely: `grants.sqlite` becomes undecryptable only if the *passphrase itself* changes — but the passphrase is stable across rebuilds unless safeStorage loses it, in which case the provider token store is equally lost and the user is already in the re-connect flow. So no **new** degradation mode is introduced; WS5 rides the existing one.
- **No migration / no re-encrypt** on the grant store (consistent with `plaid-secrets.ts:41-46`'s owner-approved "orphan, don't migrate" decision): if the passphrase is lost, issued grants are worthless anyway (their tokens are gone from every client too). WS4 shows "no connected clients" and the user re-runs the OAuth flow. A `resetGrants()` (delete the file) escape hatch parallels `PassphraseCustody.resetToFreshRandom()` (`passphrase.ts:229`).

---

## 6. Internal sequencing

1. **S1** — `grant-store.ts` + `.types.ts` with the full interface; `openDatabaseKey`/`enforceFileMode` wiring; client + grant CRUD. Unit tests (crypto round-trip, 0600, wrong-passphrase throws).
2. **S2** — auth-code (single-use) + token (hashed) CRUD + refresh rotation + `purgeExpired`.
3. **S3** — export from `@clad/core`; WS2 composes it (unblocks WS2 S3).
4. **S4** — desktop singleton wiring + `grant_db` config field + degradation path (parallels the token-store construction already in `index.ts`).

### Dependencies
- **No upstream deps** — this is the leaf. It reuses only already-shipped `@clad/core` primitives.
- **Unblocks WS2** (clientsStore, grants, tokens) and **WS4** (`listGrants`/`revokeGrant`).
- **WS7** — `StoredGrant.profileId`/`scopes` are where a future `TrustProvider` verification result is persisted; keep the columns provider-agnostic (no KYA-specific fields yet).

---

## 7. Testing strategy (`packages/core/test/security/grant-store.test.ts`, mirroring `token-store.test.ts`)

Convention from `token-store.test.ts:1-31`: `mkdtempSync` temp dir, real `SqliteGrantStore`, `PASSPHRASE`/`WRONG_PASSPHRASE`, `statSync` mode assertions, `afterEach` rm.

**Unit:**
- Round-trip: register client → getClient; create grant → getGrant; put token → getToken(raw) hashes and matches.
- **Wrong passphrase** on reopen throws `TokenStoreKeyError` (reuse the token-store test's pattern).
- **0600**: `statSync(dbPath).mode & 0o777 === 0o600` on create and after reopen.
- **No plaintext token at rest**: `readFileSync(dbPath)` (raw bytes) does **not** contain a sample raw token or client secret substring (the `token-store.test.ts` "no plaintext" style).
- **Single-use auth code**: `consumeAuthCode` returns it once, then `undefined` (replay defence).
- **Revoke cascade**: `revokeGrant` deletes its tokens + codes; a subsequent `getToken` returns `undefined` (⇒ WS2 `verifyAccessToken` 401 — acceptance #3 mechanism).
- **Refresh rotation**: `rotateRefresh` invalidates the old and issues the new atomically; old raw refresh no longer resolves.
- **Expiry filtering**: `getToken` past `expiresAt` returns `undefined`; `purgeExpired` removes them.
- **Immutability**: `bindClientProfile` twice with different profiles is rejected (binding is set-once — acceptance #1).
- **`listGrants`/`GrantMeta`** carries no secret/hash column.

**Integration:** exercised transitively by WS2's `oauth-flow.test.ts` (register→authorize→token→verify→revoke) against a real `SqliteGrantStore` on a temp file.

---

## 8. Open questions / risks & security checklist

- **Hash vs. encrypt for tokens.** Recommendation above is **hash** the opaque tokens (we only ever compare, never return them) — simpler and strictly safer than encrypting-then-returning. Confirm nothing in WS2 needs to *reproduce* a token from the store (it doesn't — the client holds the only copy). Client secrets, by contrast, may need comparison too and can also be hashed; keep `clientName`/free-text encrypted if retained.
- **Passphrase timing.** The grant store can only open once `PassphraseCustody` has resolved the passphrase. In the mcp-server child, that arrives via `CLAD_TOKEN_PASSPHRASE` env (`mcp-server-env.ts:103,107`) — the same var the provider factory uses. So the child constructs `SqliteGrantStore` with `process.env.CLAD_TOKEN_PASSPHRASE`, and the gate in WS3 §5 (real provider ⇒ authenticated http) means the passphrase is already present whenever OAuth is active. Assert the failure mode when it's absent (throw at boot, don't silently run keyless).
- **Two openers, one file.** `key-meta.ts` supports it (`:56-60`), but here only the mcp-server child opens `grants.sqlite` (the desktop main process opens it too, for WS4's list/revoke). Both use the same passphrase, so `openDatabaseKey` verifies consistently. Ensure no write-write races: WS4 revoke (main process) and token issue (child) both write — since they're separate processes on one SQLite file, rely on SQLite's file locking; keep writes short. Flag as a risk to validate under concurrent revoke+issue.
- **Security checklist (`packages/docs/plans/desktop-app.md`):** no plaintext secret at rest (hashed tokens + encrypted secrets + 0600 + key-check); no secret over IPC (`GrantMeta` only); redactSecrets on any derived diagnostic; secret-free `TokenStoreKeyError`.
