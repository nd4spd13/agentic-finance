/**
 * SimpleFIN Bridge account/transaction -> `@clad/core` model mapping (SF4,
 * revised SF5).
 *
 * Mirrors `packages/plaid-adapter/src/mapping.ts`'s conventions (pure
 * functions, no I/O, one mapping rule per exported helper) while adapting to
 * protocol facts re-verified live in SF1 (see
 * `packages/docs/plans/simplefin-adapter.md`, "Protocol reference"):
 *
 *  - v2 accounts carry `conn_id` only (no `org` field); institution identity
 *    is resolved by joining against the top-level `connections[]` array.
 *  - `balance`/`available-balance`/transaction `amount` are numeric
 *    **strings** — parsed via {@link parseSimpleFinAmount}, which never
 *    calls `parseFloat`/`Number()` on the raw string (security invariant:
 *    "No floats for money anywhere in the mapping path").
 *  - `balance-date`/`posted`/`transacted_at` are epoch **seconds** (already
 *    JS numbers, not strings) — safe to convert with ordinary integer/Date
 *    math, no decimal-precision concerns.
 *  - accounts may carry an undocumented `holdings[]` array (investment
 *    holdings). Per the plan's discrepancy #3, this adapter intentionally
 *    ignores `holdings` for now (`@clad/core`'s `Account` model is
 *    cash-account-oriented) — tolerated, never validated, never thrown on.
 *  - transactions may carry undocumented `payee`/`memo` fields alongside
 *    `description`. `payee` (the richer, human-facing counterparty name) is
 *    surfaced as `merchant_name`; `memo` has no corresponding core field and
 *    is dropped (same "no field, no mapping" treatment Plaid's `mapping.ts`
 *    gives any Plaid field with no core analog).
 *  - `currency` is either an ISO 4217 code or a custom-currency URL (the URL
 *    case was never observed live in SF1 — see
 *    `test/fixtures/synthetic-currency-url.json`). Both are just opaque
 *    strings as far as `@clad/core`'s `currency: string` field is concerned,
 *    so no special-casing is needed here beyond passing the value through.
 *
 * SF5 note (wire-type unification): this module used to declare its own
 * parallel `SimpleFinAccountDto`/`SimpleFinTransactionDto`/etc. types,
 * duplicating `client.ts`'s fixture-verified `SimpleFinAccount`/
 * `SimpleFinTransaction`/etc. (an artifact of SF3 and SF4 having been built
 * in parallel without visibility into each other's work). `client.ts`'s
 * types are canonical now — they're exercised directly against real SF1
 * captures in `parseAccountSet` — so this module imports and consumes them
 * instead of re-declaring its own shapes. `adapter.ts` (SF5) is the module
 * that actually sits at this junction (client output feeds straight into
 * `mapAccountSet`), which is what made the duplication worth resolving now.
 */

import type { Account, Transaction } from '@clad/core'
import type {
  SimpleFinAccount,
  SimpleFinAccountSet,
  SimpleFinConnection,
  SimpleFinTransaction,
} from './client.js'
import { SimpleFinError } from './errors.js'

/**
 * Thrown when a SimpleFIN DTO cannot be mapped at all (e.g. a
 * non-numeric-looking `balance`/`amount` string). Defined here rather than
 * in `errors.ts` per the SF4 file-ownership split (SF3 owns `errors.ts`'s
 * protocol-error hierarchy); this is a mapping-local subtype of the shared
 * `SimpleFinError` base.
 */
export class SimpleFinMappingError extends SimpleFinError {
  constructor(message: string) {
    super(message, { code: 'local.mapping_error' })
    this.name = 'SimpleFinMappingError'
    Object.setPrototypeOf(this, SimpleFinMappingError.prototype)
  }
}

// ---------------------------------------------------------------------
// Amount parsing (no floats)
// ---------------------------------------------------------------------

/** Matches an optionally-signed decimal string: `-?\d+(\.\d+)?`. */
const DECIMAL_STRING_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/

/**
 * Parses a SimpleFIN numeric-string amount/balance (e.g. `"-45.50"`,
 * `"114405.51"`, `"0.00"`) into a `number`, using only string splitting and
 * `BigInt` integer math — never `parseFloat`/`Number()` on the raw string.
 *
 * This matters because native `Number()`/`parseFloat()` silently accept
 * input SimpleFIN's protocol never promises: leading/trailing whitespace
 * quirks, exponential notation (`"1e10"`), `Infinity`/`NaN` literals, and
 * empty-string-to-zero coercion. A malformed or adversarial value should
 * fail loudly instead of silently becoming a wrong monetary amount — the
 * plan's "no floats for money anywhere in the mapping path" invariant.
 *
 * The returned value is still an IEEE-754 double (that's what
 * `@clad/core`'s `Account.balance_current`/`Transaction.amount` declare);
 * this function's job is only to make the *parsing* step exact, converting
 * from decimal-string minor units to the final `number` via a single
 * division right at the end rather than a permissive float parse.
 *
 * Throws {@link SimpleFinMappingError} if `value` doesn't match the
 * expected decimal-string shape.
 */
export function parseSimpleFinAmount(value: string): number {
  const match = DECIMAL_STRING_PATTERN.exec(value.trim())
  if (!match) {
    throw new SimpleFinMappingError(
      `Invalid SimpleFIN decimal amount: ${JSON.stringify(value)}`
    )
  }

  const [, sign, wholeDigits, fractionDigits = ''] = match
  const minorUnitsDigits = `${wholeDigits}${fractionDigits}`
  const minorUnits = BigInt(minorUnitsDigits === '' ? '0' : minorUnitsDigits)
  const scale = fractionDigits.length
  const magnitude = scale === 0 ? Number(minorUnits) : Number(minorUnits) / 10 ** scale

  if (sign && magnitude !== 0) {
    return -magnitude
  }
  // Normalizes "-0.00" (magnitude 0) to a plain +0 rather than -0.
  return magnitude
}

// ---------------------------------------------------------------------
// Namespacing (`simplefin:{id}`)
// ---------------------------------------------------------------------

/** Namespaces a raw SimpleFIN account id: `simplefin:{id}`. */
export function mapAccountId(accountId: string): string {
  return `simplefin:${accountId}`
}

/**
 * Namespaces a raw SimpleFIN transaction id, scoped to its owning account.
 *
 * A composite (not bare `simplefin:{id}`) id is required here: on the
 * demo Bridge, transaction `id` is literally the `posted` epoch timestamp
 * restated as a string (an implementation detail of that server, not a
 * protocol guarantee — see the fixtures README), and the real
 * `accounts-v2-pending-window.json` fixture shows two *different* accounts
 * (`fixture-acct-savings`, `fixture-acct-checking`) sharing the exact same
 * transaction ids. A bare `simplefin:{txnId}` would collide across
 * accounts and corrupt both `@clad/core`'s per-transaction identity and
 * `cache.ts`'s `transaction_id` primary key.
 */
export function mapTransactionId(accountId: string, transactionId: string): string {
  return `simplefin:${accountId}:${transactionId}`
}

// ---------------------------------------------------------------------
// Account type heuristic
// ---------------------------------------------------------------------

/**
 * Best-effort account type classification.
 *
 * Unlike Plaid, the SimpleFIN protocol has no `type`/`subtype` field on
 * accounts at all (confirmed in SF1 — accounts only carry
 * `id`/`name`/`currency`/`balance`/`available-balance`/`balance-date`/
 * `conn_id`/`transactions`/`holdings`). With no machine-readable signal,
 * this falls back to a case-insensitive keyword match against the
 * account's free-text `name`, defaulting to `'checking'` (the same "nearest
 * fallback" behavior `plaid-adapter/src/mapping.ts`'s `mapAccountType` uses
 * for unrecognized Plaid types). This is inherently a heuristic and may
 * misclassify creatively-named accounts; there is no better signal
 * available from the protocol today.
 */
export function mapAccountType(name: string): Account['type'] {
  const lower = name.toLowerCase()
  if (lower.includes('saving')) return 'savings'
  if (lower.includes('invest') || lower.includes('brokerage')) return 'investment'
  if (lower.includes('credit') || lower.includes('card')) return 'credit'
  if (lower.includes('loan') || lower.includes('mortgage')) return 'loan'
  return 'checking'
}

// ---------------------------------------------------------------------
// Connection resolution (`conn_id` -> `connections[]`)
// ---------------------------------------------------------------------

/**
 * Resolves an account's `conn_id` against the response's top-level
 * `connections[]` array. Returns `undefined` (never throws) if the id is
 * missing or doesn't resolve — the plan's protocol reference confirms
 * `connections[]` is always present in real v2 responses, but defensive
 * code should not assume every `conn_id` is guaranteed resolvable (e.g. a
 * future protocol revision, or a hand-built test fixture).
 */
export function resolveConnection(
  connId: string | undefined,
  connections: SimpleFinConnection[]
): SimpleFinConnection | undefined {
  if (!connId) return undefined
  return connections.find((connection) => connection.conn_id === connId)
}

// ---------------------------------------------------------------------
// Account / transaction mapping
// ---------------------------------------------------------------------

/**
 * Maps a SimpleFIN v2 account to the core `Account` type.
 *
 * Mapping rules:
 *  - `id`: namespaced `simplefin:{id}` (see {@link mapAccountId}).
 *  - `type`: {@link mapAccountType} (name-based heuristic; no protocol field).
 *  - `institution`: unlike Plaid (one item = one institution, tracked at the
 *    token-store level), a single SimpleFIN access URL/item can span
 *    *multiple* institutions via distinct `connections[]` entries, so
 *    institution identity is necessarily per-account, not per-item. The
 *    resolved connection's `org_name` (falling back to its `name`) is
 *    surfaced via `@clad/core`'s `Account.institution` field.
 *
 *    SF5 fix: this used to be stashed in `subtype` instead (the "extra
 *    provider detail" slot Plaid's mapping uses for its own raw account
 *    subtype, e.g. "money market"). That collided semantically —
 *    `packages/cli/src/commands/connect.ts`'s post-connect summary reads
 *    `account.subtype ?? account.type` to print a per-account "kind" label,
 *    so a SimpleFIN account would have shown its *institution name* where a
 *    Plaid-linked account shows "checking"/"money market"/etc. `subtype` and
 *    "which institution" are different concepts and must not share a field.
 *    `@clad/core`'s `Account` gained a dedicated `institution` field for
 *    this (SF5); SimpleFIN has no per-account subtype signal at all, so
 *    `subtype` is simply left `undefined` here.
 *  - `mask`: SimpleFIN has no analogous field; always `undefined`.
 *  - `balance_current`/`balance_available`: parsed via
 *    {@link parseSimpleFinAmount}, never floats.
 *  - `holdings[]` is intentionally ignored (see module docs).
 */
export function mapAccount(
  account: SimpleFinAccount,
  connections: SimpleFinConnection[] = []
): Account {
  const connection = resolveConnection(account.conn_id, connections)
  const availableBalance = account['available-balance']

  return {
    id: mapAccountId(account.id),
    name: account.name,
    type: mapAccountType(account.name),
    subtype: undefined,
    institution: connection?.org_name ?? connection?.name ?? undefined,
    mask: undefined,
    balance_current: parseSimpleFinAmount(account.balance),
    balance_available:
      availableBalance !== undefined ? parseSimpleFinAmount(availableBalance) : undefined,
    currency: account.currency,
  }
}

/**
 * Maps a SimpleFIN v2 transaction to the core `Transaction` type.
 *
 * Mapping rules:
 *  - `id`: namespaced `simplefin:{accountId}:{id}` (see
 *    {@link mapTransactionId} for why the account id must be part of it).
 *  - `account_id`: the same namespaced id {@link mapAccount} assigns, so
 *    callers can join the two directly.
 *  - `amount`: parsed via {@link parseSimpleFinAmount}, **not negated**.
 *    SimpleFIN's signed numeric string already uses the same convention as
 *    `@clad/core` (negative = money out, positive = money in) — every
 *    observed real transaction is a negative-amount outflow (`"Fishing
 *    bait"`, `"Grocery store"`), consistent with that reading. This is the
 *    opposite situation from Plaid (positive = outflow), which is why
 *    `plaid-adapter/src/mapping.ts` negates and this does not. The
 *    positive-amount (inflow) case was never captured live; see
 *    `test/fixtures/synthetic-pending.json` for a hand-built example.
 *  - `date`: `transacted_at ?? posted`, converted from epoch seconds to a
 *    `YYYY-MM-DD` string — mirrors Plaid's `authorized_date ?? date` rule
 *    (prefer the day the transaction actually happened over the possibly
 *    later `posted`/clearing date).
 *  - `description`: SimpleFIN's `description` field, falling back to
 *    `payee`/`memo`/a fixed placeholder if a nonconforming response omits
 *    it (defensive only — `description` is documented as always present).
 *  - `merchant_name`: the undocumented `payee` field (richer counterparty
 *    name than `description`), when present.
 *  - `pending`: coerced to a strict boolean; documented but never observed
 *    live (see `test/fixtures/synthetic-pending.json`).
 *  - `category`: SimpleFIN has no category taxonomy; always `undefined`.
 */
export function mapTransaction(transaction: SimpleFinTransaction, accountId: string): Transaction {
  const epochSeconds = transaction.transacted_at ?? transaction.posted

  return {
    id: mapTransactionId(accountId, transaction.id),
    account_id: mapAccountId(accountId),
    amount: parseSimpleFinAmount(transaction.amount),
    date: epochSecondsToDateString(epochSeconds),
    description: transaction.description ?? transaction.payee ?? transaction.memo ?? '(no description)',
    merchant_name: transaction.payee ?? undefined,
    category: undefined,
    pending: Boolean(transaction.pending),
  }
}

/**
 * Maps a full SimpleFIN v2 `AccountSet` (the parsed output of `client.ts`'s
 * `parseAccountSet`, or the fixture-shaped subset of one in tests) to flat
 * `Account[]`/`Transaction[]` arrays, joining each account's `conn_id`
 * against `connections[]` and each transaction against its owning account's
 * (already-namespaced) id. Ignores `accountSet.errors`/`apiMessages` —
 * they're non-fatal protocol-level warnings (e.g. rate-limit notices), out
 * of scope for a pure data-mapping step. `adapter.ts` (SF5) does not
 * currently inspect or surface them either — a deliberate scope cut, not an
 * oversight; see that file's handoff notes for a future task to pick up.
 */
export function mapAccountSet(accountSet: SimpleFinAccountSet): {
  accounts: Account[]
  transactions: Transaction[]
} {
  const connections = accountSet.connections ?? []
  const accounts: Account[] = []
  const transactions: Transaction[] = []

  for (const rawAccount of accountSet.accounts) {
    accounts.push(mapAccount(rawAccount, connections))
    for (const rawTransaction of rawAccount.transactions ?? []) {
      transactions.push(mapTransaction(rawTransaction, rawAccount.id))
    }
  }

  return { accounts, transactions }
}

/**
 * Converts a SimpleFIN epoch-seconds timestamp (already a JS number — no
 * string parsing involved, so the "no floats" amount invariant doesn't
 * apply here) to a `YYYY-MM-DD` calendar-date string in UTC, matching the
 * date-string convention `@clad/core`'s `Transaction.date` uses (compare
 * `plaid-adapter/src/mapping.ts`'s pass-through of Plaid's own
 * already-formatted date strings).
 */
export function epochSecondsToDateString(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}
