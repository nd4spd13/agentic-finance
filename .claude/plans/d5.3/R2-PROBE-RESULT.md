# R2 probe result — `http://127.0.0.1` OAuth issuer vs. `mcp-remote@0.1.38`

Risk under test (`SEQUENCING.md` §3, row R2): *"mcp-remote / Claude reject an
`http://127.0.0.1` OAuth issuer (RFC 8414 expects https; loopback exempt per
BCP 212, but unverified against these clients)."* Mitigation on file: *"Verify
in PR 5 with a real mcp-remote against the metadata endpoints before building
PR 6 on the assumption."* This is that verification, run against the D5.3 WS2
S2-S3 implementation (metadata + DCR front door, this PR).

## Verdict: **PASS — no workaround needed, no code change required.**

The pinned `mcp-remote@0.1.38` performs RFC 9728 protected-resource
discovery, RFC 8414 authorization-server discovery, and RFC 7591 Dynamic
Client Registration against a plain `http://127.0.0.1:<port>` issuer with
**zero** HTTPS-only rejection at any step, and successfully persists a
registered client into the real, encrypted `SqliteGrantStore`. The
subsequent `/authorize` redirect reaches the server and (as expected, since
authorize()` is a Wave-4 throwing seam) the flow dead-ends there — exactly
the "success" shape the probe procedure called for.

Wave 4 (real `authorize`/`token`/`verifyAccessToken`/`revokeToken`) is **not
blocked** by the loopback-issuer question. No `--allow-http` flag, no
`MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` env var, and no fork/patch of
`mcp-remote` was needed.

---

## Why, at the code level (static confirmation, then verified live)

Two independent client-side checks exist in the installed
`mcp-remote@0.1.38`, and both explicitly exempt `127.0.0.1`/`localhost` +
`http:` from the HTTPS requirement:

1. **CLI argument validation** (`dist/chunk-65X3S4HB.js:20819-20821`, the
   compiled bundle of `mcp-remote`'s `src/lib/utils.ts`-equivalent):
   ```js
   const isLocalhost = (url2.hostname === "localhost" || url2.hostname === "127.0.0.1") && url2.protocol === "http:";
   if (!(url2.protocol == "https:" || isLocalhost || allowHttp)) {
     log("Error: Non-HTTPS URLs are only allowed for localhost or when --allow-http flag is provided");
     ...
     process.exit(1);
   }
   ```
   This governs the initial `<server-url>` CLI argument only (i.e. the `/mcp`
   URL itself) — it does not by itself prove the *discovered issuer* (a
   possibly-different URL returned by the PRM document's
   `authorization_servers` field) is exempted too, which is why the live run
   below matters.

2. **Server-side** (`@modelcontextprotocol/sdk@1.29.0`,
   `dist/esm/server/auth/router.js`'s `checkIssuerUrl`, used by both
   `mcpAuthRouter` and `mcpAuthMetadataRouter`):
   ```js
   const checkIssuerUrl = (issuer) => {
     if (issuer.protocol !== 'https:' && issuer.hostname !== 'localhost' && issuer.hostname !== '127.0.0.1' && !allowInsecureIssuerUrl) {
       throw new Error('Issuer URL must be HTTPS');
     }
     ...
   };
   ```
   Confirms our own server never refuses to construct/serve
   `http://127.0.0.1:<port>` metadata in the first place — this is *why*
   `http-app.ts` can pass `issuerUrl: new URL('http://127.0.0.1:' + port)`
   unmodified, with no `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` escape
   hatch needed.

Neither of these, alone, proves the FULL discovery -> DCR -> authorize chain
survives contact with the real binary (e.g. a *third*, undocumented check
inside the OAuth provider construction path could still reject a
non-`localhost`-string-literal issuer discovered via PRM, or a redirect
builder could choke on the scheme). Hence the live run.

---

## Procedure actually run

1. Built the worktree (`pnpm --filter @clad/mcp-server... build`).
2. Started the REAL flag-on server (`node dist/server.js`) with:
   `CLAD_MCP_TRANSPORT=http`, `CLAD_MCP_HTTP_PORT=18765`,
   `CLAD_MCP_AUTH=oauth`, `CLAD_PROVIDER=dummy`, a temp `CLAD_POLICY_PATH`,
   `CLAD_GRANT_DB`, `CLAD_TOKEN_PASSPHRASE`, `CLAD_AGENT_ID=probe-agent`.
   Confirmed `/.well-known/oauth-authorization-server` serves
   `"issuer":"http://127.0.0.1:18765/"` correctly (see transcript below).
3. **Gap found and closed before driving mcp-remote**: in this wave,
   `requireBearerAuth` is deliberately NOT mounted in front of `/mcp` yet
   (that's explicit Wave-4/WS3-S3 scope — see `http-app.ts`'s header
   comment). mcp-remote only performs its OAuth dance when challenged by a
   `401` with a `WWW-Authenticate: ... resource_metadata=...` header; without
   that challenge, an unmodified run just connects to `/mcp` straight away
   and never touches `/register` or `/authorize` at all (this WAS observed —
   see "Run 1" below). To exercise the actual R2 question (does mcp-remote's
   OAuth *client* code reject the loopback issuer), a small throwaway probe
   harness (`packages/mcp-server/.r2-probe-server.mjs`, **never committed,
   deleted after the run**) reconstructed the Wave-4-shaped mount order using
   the REAL, already-built `CladOAuthProvider` + `SqliteGrantStore` plus the
   SDK's own `requireBearerAuth` in front of a dummy `/mcp` — i.e. exactly
   what Wave 4 will look like, with nothing about the metadata/DCR/issuer
   machinery altered from what's actually in this PR.
4. Ran the pinned binary directly:
   `node node_modules/.pnpm/mcp-remote@0.1.38/node_modules/mcp-remote/dist/proxy.js http://127.0.0.1:18767/mcp 18768 --debug`
   with `HOME` pointed at a scratch dir (isolated `~/.mcp-auth/` token
   storage).
5. Captured the probe server's request log (stderr) and mcp-remote's full
   `--debug` stderr output verbatim (below).
6. Verified the DCR-registered client is a real row in the encrypted
   `SqliteGrantStore` by opening the same `dbPath`/passphrase and calling
   `getClient(<the id mcp-remote logged>)` directly.
7. Killed every spawned process (`mcp-remote`, the probe harness, the
   flag-on server) and deleted the throwaway probe script.

---

## Run 1 — unmodified app (`/mcp` reachable with no token yet, WS3 S3 not landed)

This run demonstrates *why* the probe harness in step 3 above was necessary
— included for completeness/honesty, not as the R2 evidence itself.

```
[2026-07-19T03:08:57.680Z] Starting OAuth server discovery { serverUrl: 'http://127.0.0.1:18765/mcp' }
[2026-07-19T03:08:57.687Z] Fetching Protected Resource Metadata { metadataUrl: 'http://127.0.0.1:18765/.well-known/oauth-protected-resource/mcp' }
[2026-07-19T03:08:57.690Z] Successfully fetched Protected Resource Metadata {
  resource: 'http://127.0.0.1:18765/mcp',
  authorizationServers: [ 'http://127.0.0.1:18765/' ],
  scopesSupported: [ 'clad:accounts.read', 'clad:transactions.read', 'clad:actions.request', 'clad:audit.read' ]
}
[2026-07-19T03:08:57.693Z] Successfully fetched authorization server metadata { issuer: 'http://127.0.0.1:18765/', scopeCount: 4 }
[90646] Connected to remote server using StreamableHTTPClientTransport
```

Even here — with NO forced 401 — mcp-remote's *unconditional, upfront*
`discoverOAuthServerInfo()` call (it runs this before attempting any MCP
connection at all, regardless of whether the server ends up requiring auth —
see `proxy.ts`'s `runProxy`) already hit both `/.well-known/*` documents over
plain `http://127.0.0.1` successfully. It then connected to `/mcp` directly
because no `401` challenge occurred (today's `/mcp` doesn't gate on a token
yet), so it never proceeded to `/register` or `/authorize` in this run.

## Run 2 — probe harness (`requireBearerAuth` in front of `/mcp`, the Wave-4 shape)

**`curl` sanity check before driving mcp-remote:**
```
$ curl -sS -i http://127.0.0.1:18767/mcp
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="http://127.0.0.1:18767/.well-known/oauth-protected-resource/mcp"
{"error":"invalid_token","error_description":"Missing Authorization header"}
```

**Probe server's own request log (verbatim, chronological):**
```
[probe-server] listening on http://127.0.0.1:18767/mcp
[probe-server] GET /mcp
[probe-server] GET /mcp
[probe-server] GET /.well-known/oauth-protected-resource/mcp
[probe-server] GET /.well-known/oauth-authorization-server
[probe-server] POST /mcp
[probe-server] GET /.well-known/oauth-protected-resource/mcp
[probe-server] GET /.well-known/oauth-authorization-server
[probe-server] POST /register
[probe-server] GET /authorize?response_type=code&client_id=fd52b24f-facf-4e17-b846-3260441eb0f7&code_challenge=9AeBeIGNPiHLGS-hrUwc28DlI95y1x9DF_3yf2HLgyo&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A18768%2Foauth%2Fcallback&state=8360851d-66e7-4e51-af29-65135281313c&scope=clad%3Aaccounts.read%20clad%3Atransactions.read%20clad%3Aactions.request%20clad%3Aaudit.read&resource=http%3A%2F%2F127.0.0.1%3A18767%2Fmcp
```

**mcp-remote's own `--debug` stderr (key lines, verbatim, chronological):**
```
[90711] Discovering OAuth server configuration...
[2026-07-19T03:11:13.459Z] Starting Protected Resource Metadata discovery { resourceUrl: 'http://127.0.0.1:18767/mcp', hasWWWAuthenticateHeader: false }
[2026-07-19T03:11:13.459Z] Fetching Protected Resource Metadata { metadataUrl: 'http://127.0.0.1:18767/.well-known/oauth-protected-resource/mcp' }
[2026-07-19T03:11:13.461Z] Successfully fetched Protected Resource Metadata {
  resource: 'http://127.0.0.1:18767/mcp',
  authorizationServers: [ 'http://127.0.0.1:18767/' ],
  scopesSupported: [ 'clad:accounts.read', 'clad:transactions.read', 'clad:actions.request', 'clad:audit.read' ]
}
[2026-07-19T03:11:13.459Z] Fetching authorization server metadata { serverUrl: 'http://127.0.0.1:18767/', metadataUrl: 'http://127.0.0.1:18767/.well-known/oauth-authorization-server' }
[90711] Discovered authorization server: http://127.0.0.1:18767/
[2026-07-19T03:11:13.459Z] [90711] Connecting to remote server: http://127.0.0.1:18767/mcp
[2026-07-19T03:11:13.484Z] Authentication error detected { errorCode: undefined, errorMessage: 'Unauthorized', ... }
[2026-07-19T03:11:13.484Z] Calling authInitializer to start auth flow
[2026-07-19T03:11:13.470Z] Reading client info
[2026-07-19T03:11:13.470Z] Client info result: Not found
[2026-07-19T03:11:13.479Z] Saving client info { client_id: 'fd52b24f-facf-4e17-b846-3260441eb0f7' }
[2026-07-19T03:11:13.481Z] authorizationServerMetadata: {"issuer":"http://127.0.0.1:18767/","authorization_endpoint":"http://127.0.0.1:18767/authorize","token_endpoint":"http://127.0.0.1:18767/token","registration_endpoint":"http://127.0.0.1:18767/register",...}
[90711]
Please authorize this client by visiting:
http://127.0.0.1:18767/authorize?response_type=code&client_id=fd52b24f-facf-4e17-b846-3260441eb0f7&code_challenge=9AeBeIGNPiHLGS-hrUwc28DlI95y1x9DF_3yf2HLgyo&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A18768%2Foauth%2Fcallback&state=8360851d-66e7-4e51-af29-65135281313c&scope=...
[90711] Browser opened automatically.
[90711] OAuth callback server running at http://127.0.0.1:18768
[90711] Authentication required. Waiting for authorization...
```

**No line anywhere in this run says "HTTPS", "insecure", or otherwise
rejects the scheme.** The `POST /register` produced HTTP 201 with a real
`client_id`; `Saving client info { client_id: 'fd52b24f-facf-4e17-b846-3260441eb0f7' }`
confirms mcp-remote itself accepted and persisted that registration
locally too.

**Grant-store verification (independent of both logs above — reads the SAME
encrypted SQLite file the running probe server's `SqliteGrantStore` instance
wrote to):**
```
$ node --input-type=module -e "
import { SqliteGrantStore } from '.../packages/core/dist/index.js';
const store = new SqliteGrantStore({ dbPath: '.../r2-probe-grants.sqlite', passphrase: 'r2-probe-passphrase' });
console.log(JSON.stringify(store.getClient('fd52b24f-facf-4e17-b846-3260441eb0f7'), null, 2));
"
{
  "clientId": "fd52b24f-facf-4e17-b846-3260441eb0f7",
  "clientName": "MCP CLI Proxy",
  "redirectUris": [ "http://localhost:18768/oauth/callback" ],
  "tokenEndpointAuthMethod": "none",
  "clientIdIssuedAt": 1784430673,
  "createdAt": "2026-07-19T03:11:13.478Z"
}
```

`clientName: "MCP CLI Proxy"` matches `mcp-remote`'s own
`NodeOAuthClientProvider` constructor call (`clientName: "MCP CLI Proxy"` in
`proxy.ts`) — this is unambiguously the row `mcp-remote` itself created via
`POST /register`, not an artifact of the test harness.

`GET /authorize` then reached the probe server (see request log above);
`CladOAuthProvider.authorize()` throws `OAuthFlowNotImplementedError`
there (Wave-4 seam, by design — see `provider.ts`), which the SDK's
`authorizationHandler` catches and turns into a `302` redirect to the
client's own `redirect_uri` with `?error=server_error&...` (verified
separately, at the unit level, in `test/oauth/oauth-flow.test.ts`'s
`GET /authorize redirects to redirect_uri with a generic error` case) — the
expected, documented dead-end. mcp-remote was left waiting on its own local
OAuth callback server for a browser-completed redirect that this headless
probe never drives to completion; that is outside R2's scope (R2 is about
the *issuer scheme*, not completing an interactive human consent step) and
was terminated cleanly (`kill`) rather than pursued further.

---

## Residual notes (not blockers, recorded for Wave 4 planning)

- **The 401 challenge is required to trigger the OAuth path at all.**
  mcp-remote is "lazy" about auth: it always does the upfront `PRM`+`AS`
  discovery fetch regardless, but only proceeds to `/register` +
  `/authorize` when a request to `/mcp` (or `/mcp`'s `initialize`) comes
  back `401` with a `WWW-Authenticate` header naming the resource-metadata
  URL. Wave 4 / WS3-S3 (mounting `requireBearerAuth` in front of `/mcp`) is
  what makes this trigger in the real shipped app — today, with the flag on
  but bearer enforcement not yet wired, a client connects to `/mcp`
  unauthenticated regardless of `CLAD_MCP_AUTH`. This is already the
  documented, intentional state of S2-S3 (`http-app.ts`'s header comment);
  flagged here only so Wave 4 doesn't need to re-derive it.
- **`mcp-remote`'s own CLI-arg check treats `127.0.0.1`+`http:` as exempt
  unconditionally** (`isLocalhost` check, §"Why, at the code level" above) —
  Claude Desktop itself invokes `mcp-remote` with the loopback URL as that
  same first CLI argument (`claude-desktop-config.ts`), so this exemption
  covers the actual shipped invocation shape, not just this probe's direct
  CLI usage.
- No attempt was made to complete the interactive consent step (would require
  a real browser + a working `/authorize` implementation, i.e. Wave 4) — out
  of scope for R2, which is specifically about the issuer-scheme question.
