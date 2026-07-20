# MCP account-metadata triage

**Date:** 2026-07-18
**Source:** Clad MCP used from a Claude Cowork chat, v0.5.0 (`839d4e3`), SimpleFIN provider,
session running with the `CLAD_AGENT_ID=analyst` workaround.

**Reported symptom:** `clad_get_balances` returned 11 accounts exposing only an opaque
account ID and a balance — no name, no type, no institution. Editing the Analyst policy in
the desktop Policy Editor (ticking all five account types + `account_number`) and
restarting the MCP client changed nothing across multiple attempts.

**Reporter's hypothesis:** output was being filtered by the agent policy.
**Verdict: incorrect.** The policy edit saved correctly to `~/.clad/policy.yaml`. No policy
value could have produced the missing fields — see CLAD-1. The remaining issues below were
found while establishing that.

---

## CLAD-1 — `clad_get_balances` discards account metadata it has already fetched

**Bucket:** Clad-side defect · **Severity:** high (causes fabricated data — see below)

[`packages/mcp-server/src/tools/clad_get_balances.ts:27-34`](../../packages/mcp-server/src/tools/clad_get_balances.ts) fetches
the account list, uses it *only* as a filter predicate, then discards it and returns
`getBalance()` results:

```ts
const accounts = await context.provider.getAccounts(context.agentId)
const filtered = accounts.filter(a => !args.account_type || a.type === args.account_type)
const balances = await Promise.all(
  filtered.map(a => context.provider.getBalance(context.agentId, a.id))
)
return { content: [{ type: 'text', text: JSON.stringify(balances, null, 2) }] }
```

`Balance` ([`data-provider.types.ts:51`](../../packages/core/src/types/data-provider.types.ts)) is only
`account_id, current, available, currency, last_updated, stale`. `Account` — the object
discarded one line earlier — carries `name`, `type`, `subtype`, `institution`, `mask`.

The response type structurally cannot carry a name or type, which is why no amount of
policy editing changed the output.

### Impact: fabricated financial metadata

With no type available, the client inferred account types from the **sign of the balance**
and presented them in a table as `Asset (checking?)` / `Liability (credit card?)`. For a
finance tool this is a correctness failure, not a cosmetic one: the agent is guessing at
account classification and rendering the guess as data.

### The narrowing saves nothing

Verified against both adapters — the "lightweight balance refresh vs. heavyweight account
fetch" split does not exist at the provider layer:

- **SimpleFIN** ([`adapter.ts:53-62`](../../packages/simplefin-adapter/src/adapter.ts)) — documented
  in the adapter's own comment: no single-account balance shortcut exists on the wire.
  `/accounts` is always item-wide (`balances-only=1` is still item-wide). `getBalance()`
  runs `refreshAllDueItems()` — identical to `getAccounts()` — then reads one row from the
  same `accounts_cache`, a row that already holds `name`, `type`, and `institution`.
- **Plaid** ([`adapter.ts:98-105`](../../packages/plaid-adapter/src/adapter.ts)) — calls
  `accountsBalanceGet`, maps the response to **full `Account` objects**, upserts them to
  cache, then `.find()`s one and narrows it to a `Balance`.

On both providers the complete account is in memory at the instant `getBalance` drops
everything but four fields. Zero network calls, API quota, or DB reads are saved. At the
tool layer it is strictly worse: the handler already pays for `getAccounts()`
unconditionally, then makes N additional `getBalance()` calls, and returns the lesser of
the two results.

### Design decision

The genuine axis of variation is **freshness, not fields**. Plaid does have two materially
different endpoints — `/accounts/get` (cached, cheap) vs `/accounts/balance/get` (forces a
live bank pull, rate-limited) — but that is about how hard you hit the bank, which is
orthogonal to which fields are returned. The current design conflated the two and selected
the axis that buys nothing.

Options considered:

| Option | Assessment |
| --- | --- |
| **A. Enrich `clad_get_balances` in place** | **Chosen.** Additive → non-breaking. One-file change. Fixes the reported problem. Cost: tool name undersells its output. |
| B. Keep lean, add `clad_get_accounts`, agent joins across calls | No accounts tool exists today, so this is net-new surface, not a smaller change. Already falsified in the wild: the reported hallucination *is* the failure mode of forcing the model to supply missing metadata itself. |
| C. Collapse to one `clad_get_accounts` | Honest to the wire shape, fewer tools → better tool selection. But breaks a shipped v0.5.0 contract referenced by name in external mcp-remote configs, to solve what A already solves. |
| D. One tool + `include_metadata`/`fields` param | Rejected. Output shape becomes a decision the model must get right, and policy evaluation now depends on a caller-supplied flag. |

**Decision:** implement A. If the refresh-cost distinction later earns its keep (likely when
Plaid becomes first-class), express it as a parameter on the *same* tool —
`refresh: "cached" | "live"` — rather than as two tools with divergent field sets.

**Do not ship A in isolation — see the sequencing note at the end.**

---

## CLAD-2 — `account_number` / `routing_number` policy toggles are unenforced

**Bucket:** Clad-side defect · **Severity:** medium (misleading privacy control)

`AccountPermissions.account_number` and `.routing_number`
([`policy.types.ts:25`](../../packages/core/src/types/policy.types.ts)) have **no consumers**. They
appear only in:

- `packages/core/src/policy/policy.schema.json:70,74`
- [`PolicyEditor.tsx:430,433`](../../packages/desktop/src/renderer/src/components/PolicyEditor.tsx) (the checkboxes)
- `packages/desktop/src/shared/ipc.ts:255-256` (the type)
- `packages/desktop/src/main/lib/config.ts:192-193` (defaults)

No tool and no evaluator branch reads either field. Ticking the box does nothing.

Currently inert — nothing emits account numbers today — but the UI presents a privacy
control that does not exist, which is worse than offering no control at all. Becomes
live-and-load-bearing the moment CLAD-1 ships, since `mask` (last four) is the natural
referent for `account_number`.

**Fix:** wire `account_number` to gate `mask` in the account-shaped response introduced by
CLAD-1. Either implement `routing_number` or remove it — no adapter currently surfaces a
routing number, so removal is defensible.

---

## CLAD-3 — `accounts.visible[]` is not enforced on the balance path

**Bucket:** Clad-side defect · **Severity:** medium (policy silently not applied)

[`evaluator.ts:81`](../../packages/core/src/policy/evaluator.ts) only consults the visible list when
`request.resource === 'accounts'` **and** `request.account_type !== undefined`:

```ts
if (request.resource === 'accounts' && permissions.accounts?.visible) {
  if (request.account_type !== undefined) { ... }
}
```

`clad_get_balances` evaluates with `resource: 'balance'` and passes no `account_type`
(`clad_get_balances.ts:18-21`), so the visible list is never checked on this path. All 11
accounts were returned regardless of its contents — the list neither restricted nor granted
anything, in either direction.

**Related schema smell:** the live policy's `visible` list mixes account *identifiers*
(`checking-001`, `savings-001`) with account *types* (`checking`, `savings`, `credit`, …).
The field conflates identity and classification; worth resolving before more logic is built
on it.

---

## CLAD-4 — No policy field governs account name/type/institution visibility

**Bucket:** Design gap · **Severity:** medium (blocks CLAD-1 from shipping safely)

`AccountPermissions` is `visible[] | balance | account_number | routing_number`. There is no
field controlling whether an agent may see an account's **name**, **type**, **subtype**, or
**institution**.

Not a problem while those fields are never emitted. Becomes one the moment CLAD-1 ships.
Note that account names in practice often embed both an institution and a partial account
number ("Chase Freedom …4821"), so `name` deserves its own gate rather than riding along
with `type`.

**Fix:** extend `AccountPermissions` — and correspondingly `policy.schema.json`, the Policy
Editor UI, and `packages/docs/policy-reference.md`. Note
`packages/core/test/policy/doc-schema-drift.test.ts` asserts docs and schema stay in sync,
so the docs update is required, not optional.

---

## CLAD-5 — Policy changes require a full desktop-app restart, with no signal to the user

**Bucket:** Clad-side gap (docs and/or feature) · **Severity:** low-medium (usability trap)

Policy is parsed **once**, at MCP child startup
([`server-core.ts:136`](../../packages/mcp-server/src/server-core.ts)), and held in
`resources.policy` for the process lifetime. No `fs.watch`, `chokidar`, or `reloadPolicy`
exists anywhere in `packages/*/src`.

The trap: restarting the *client* (or reconnecting mcp-remote) does not reload policy. The
reconnect is served by the same long-lived supervised child, still holding the stale
in-memory config. A full **quit and relaunch of the Clad desktop app** is required — and the
relaunch must preserve `CLAD_AGENT_ID`, or the known `default-agent` denial bug returns.

This is what the reporter hit when "restarting the MCP server" changed nothing. It was moot
in this instance (CLAD-1 meant a correct reload would still have produced no metadata) but
it will bite again.

**Fix options:** (a) document the restart requirement in `packages/docs/policy-reference.md`
and surface it in the Policy Editor after a save; (b) watch the policy file and hot-reload;
(c) have the Policy Editor's save signal the supervised child to re-parse. (c) is probably
the best fit — the desktop app already supervises the child and knows when a save happened.

---

## Not defects

- **Truncated account IDs ("last 8 of ID").** Client-side display truncation in Cowork. Clad
  returns the full `account_id`.
- **The policy edit itself.** Saved correctly to `~/.clad/policy.yaml`; the file on disk
  reflects all five account types and `account_number: true`.
- **The `default-agent` denial.** Known, fix in flight, correctly worked around in this
  session.

---

## Sequencing note

CLAD-1 emits `name`, `type`, `institution`, and `mask` where only an opaque ID leaves the
process today — strictly more PII, on a path that currently has:

- no working `visible[]` enforcement (CLAD-3),
- no field-level gate for name/type/institution (CLAD-4),
- dead `account_number`/`routing_number` toggles (CLAD-2),
- and, pre-D5.3, a single shared agent identity across all MCP clients behind an
  unauthenticated loopback server.

**Land CLAD-2, CLAD-3, and CLAD-4 with or before CLAD-1 — not after.** Shipping the
enrichment first widens data exposure through a policy path that is known not to enforce
anything.

Convenient convergence: `mask` is the natural referent for `account_number`, so CLAD-2's fix
supplies the gate for the most sensitive field CLAD-1 introduces.
