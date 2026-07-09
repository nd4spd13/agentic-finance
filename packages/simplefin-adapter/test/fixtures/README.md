# SimpleFIN fixtures (SF1 capture)

These fixtures are **real responses** captured from the public SimpleFIN Bridge
demo endpoint (`https://beta-bridge.simplefin.org`) on **2026-07-08**, as part
of task SF1 in [`packages/docs/plans/simplefin-adapter.md`](../../../docs/plans/simplefin-adapter.md).
They are used by SF3/SF4 to test response parsing and mapping without hitting
the network (and without burning the ~24-requests/day quota).

## How they were captured

1. Fetched a **fresh** demo Setup Token from the live Developer Guide
   (`https://beta-bridge.simplefin.org/info/developers`) via a plain `curl` GET
   of that page (this does not count against the Bridge's `/accounts` rate
   limit — it's a normal page load, not an API call). Did not reuse any token
   previously copied into docs or examples.
2. Base64-decoded the token to get the claim URL
   (`https://beta-bridge.simplefin.org/simplefin/claim/DEMO-v2-<redacted>`).
3. Claimed it **once**: `curl -H "Content-Length: 0" -X POST <claim-url>`.
   This is one-time by design — the setup token is consumed and an
   `ACCESS_URL` (`https://<user>:<pass>@beta-bridge.simplefin.org/simplefin`)
   is returned. The access URL is a credential and was never written to disk
   outside of a private scratch directory outside this repo, never logged in
   full, and does not appear in any file below (verified by `grep` — see the
   final task report).
4. Made exactly **3** `GET {accessUrl}/accounts` requests total, all returning
   HTTP 200 with an empty `errlist` (no rate-limit warnings surfaced):
   - `accounts-v2-plain.json` — `?version=2` (default: today's transactions only, no `pending`, no date window).
   - `accounts-v2-balances-only.json` — `?version=2&balances-only=1`.
   - `accounts-v2-pending-window.json` — `?version=2&pending=1&start-date=<now-30d>&end-date=<now+5d>` (35-day window, well under the 90-day cap).

## Scrubbing applied

The demo Bridge only ever returns synthetic placeholder data (no real bank
accounts), so there was no real PII to remove. For hygiene and to decouple
the fixtures from this specific capture run, the following identifiers were
replaced with stable fake values (consistently across all three files):

| Field | Captured value | Fixture value |
|---|---|---|
| `accounts[].id` | `"Demo Savings"` | `"fixture-acct-savings"` |
| `accounts[].id` | `"Demo Checking"` | `"fixture-acct-checking"` |
| `accounts[].id` | `"Demo Empty Account"` | `"fixture-acct-empty"` |
| `accounts[].conn_id` / `connections[].conn_id` | `"CON-SIMPLEFIN-DEMO"` | `"fixture-conn-demo"` |
| `connections[].org_id` | `"simplefin.demoorg"` | `"fixture-org-demo"` |
| `accounts[].holdings[].id` | `"25bc4910-4cb4-437b-9924-ee98003651c5"` (a UUID) | `"fixture-holding-aapl"` |

Left untouched (not sensitive — they're the Bridge's own public, credential-free
values, or non-identifying demo labels/amounts): `accounts[].name`,
`connections[].name`/`org_name`/`org_url`/`sfin_url` (both point at the public
`beta-bridge.simplefin.org` domain, no userinfo), transaction `id`/`posted`/
`amount`/`description`/`payee`/`memo`/`transacted_at`/`mcc`, and all balances.

Transaction `id` values are literally the `posted` epoch timestamp restated as
a string — that's the demo server's own convention, not something we
introduced, and it's preserved as an accurate structural observation (see the
"Discrepancies" section in the plan doc).

`accounts-v2-pending-window.json` was **truncated** to the first 8
transactions per account to keep the fixture a reasonable size; the live
capture returned 68 transactions each for the two non-empty accounts (all
`Fishing bait` / `Grocery store` entries alternating — repetitive synthetic
demo data) and 0 for `fixture-acct-empty`. None of the 136 transactions in the
live pending-window response had `"pending": true` — the demo dataset does not
appear to include any pending transactions, so that field/value was not
empirically observed (see plan doc discrepancies).

## Notable structural findings (see plan doc for the full discrepancy list)

- Every response includes an `errlist` array (empty on success) **and** a
  top-level `connections` array — both present simultaneously, matching the
  v2 shape. No response used the legacy `errors` key.
- Every response also included `x-api-message` (only present on the plain
  `?version=2` request) — an informational hint array not documented in the
  plan's protocol reference: `["Provide a 'start-date' parameter to receive
  transactions prior to yesterday"]`. This confirms that omitting
  `start-date` restricts the default window to roughly "yesterday onward"
  rather than full history.
- Accounts carry `conn_id` only — no `org` field — confirming v2 replaced the
  flat `org` field with connection linkage via `conn_id` + a separate
  top-level `connections[]` array.
- `balances-only=1` does **not** omit the `transactions`/`holdings` keys; it
  returns them as empty arrays. Parsers should not use key-presence to detect
  balances-only mode.
- Accounts include a `holdings[]` array (investment holdings: `id`, `created`,
  `cost_basis`, `currency`, `description`, `market_value`, `purchase_price`,
  `shares`, `symbol`) that is not mentioned anywhere in the plan's protocol
  reference or in the live protocol/developer docs text extracted during SF1.
  It was empty for `fixture-acct-checking` and `fixture-acct-empty` in every
  capture, but `fixture-acct-savings` carried one non-empty AAPL holding in
  both `accounts-v2-plain.json` and `accounts-v2-pending-window.json` (absent
  only from `accounts-v2-balances-only.json`, consistent with `balances-only=1`
  suppressing holdings the same way it suppresses transactions).
- Transactions include `payee` and `memo` fields in addition to `description`
  — also undocumented in the plan's protocol reference.
- `currency` was always the plain ISO 4217 code `"USD"` in these captures;
  the "custom currency URL" case mentioned in the plan was not observed and
  remains unconfirmed against a live response.
- No pending (`"pending": true`) transactions were observed in the demo
  dataset even when requesting `pending=1` over a 35-day window, so that
  field's presence/shape on a real pending transaction was not confirmed
  empirically here — only documented per the spec.

## Re-capturing

If these fixtures ever need refreshing, repeat the steps above: fetch a fresh
demo token from the developers page, claim it once, and make at most a
handful of `/accounts` requests (the Bridge allows roughly 24/day — see the
"Rate limits" note in the plan doc). Never commit the access URL or setup
token; scrub new account/conn/org identifiers the same way as above before
committing.
