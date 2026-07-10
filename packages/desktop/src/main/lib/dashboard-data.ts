/**
 * D2.3 dashboard data layer — balances + recent transactions, via the
 * provider-agnostic factory in `./provider-factory.ts`.
 *
 * RATE-LIMIT DISCIPLINE (desktop-app.md D2.3, "critical"): this store NEVER
 * calls the provider on its own initiative — no interval polling, no
 * fetch-on-first-read, no fetch hidden inside a getter. `getSnapshot()` is a
 * pure, synchronous read of whatever was last fetched (in-memory only —
 * resets on app restart; that's intentional, not a gap, see below). The ONLY
 * method that ever talks to the provider is `refresh()`, wired to
 * `dashboard:refresh` in `shared/ipc.ts` / `main/index.ts`. Quoting the plan
 * directly: "Stale data shown honestly beats fresh data that burns quota."
 * That core rule is unconditional and unchanged by the amendment below: this
 * module still never initiates a fetch itself, still has no timer/interval
 * anywhere in it, and `refresh()` is still the only method that reaches the
 * provider.
 *
 * 2026-07-10 owner-QA amendment: the renderer (`Dashboard.tsx`) is now
 * allowed exactly ONE automatic call to `refreshDashboard` per app session —
 * fired when the dashboard first mounts with `lastRefreshed === null` (i.e.
 * `getSnapshot()`/`getDashboardSnapshot` reports nothing has been fetched
 * yet this session) and `state === 'ready'` (provider fully configured; a
 * `'no-provider-configured'` or already-`'error'` snapshot never triggers
 * it). Product rationale: a fresh launch showing "never refreshed" and an
 * empty dashboard until the user notices and clicks Refresh was worse UX
 * than the rate-limit purity the original D2.3 rule optimized for. This is
 * still bounded to one provider call per session — not polling, not
 * fetch-on-every-mount, not a timer — the renderer guards it with a
 * one-shot ref so a failed auto-refresh doesn't retry/loop; the user can
 * still always hit Refresh manually afterward. See `Dashboard.tsx`'s doc
 * comment for the renderer-side guard and `desktop-app.md`'s D2.3 section
 * for the amended plan wording.
 *
 * Why an in-memory-only cache (no disk persistence) is the right amount of
 * scope here: `PlaidAdapter` already owns a real degrade-to-SQLite-cache
 * story for its own outages (`packages/plaid-adapter/src/adapter.ts`'s
 * `stale: true` fallback) — this layer's job is strictly "don't call the
 * network unprompted", not "survive a restart with data intact". A restart
 * showing `lastRefreshed: null` and an empty state ("click Refresh to load
 * data") is an honest reflection of "we haven't asked the provider anything
 * yet this session", not a stale/wrong number silently served as current.
 *
 * Provider-agnostic by construction: this module only ever talks to the
 * `FinancialDataProvider` interface via `createFinancialProvider()` — when
 * the SimpleFIN adapter lands on main (separate PR) and `provider-
 * factory.ts` grows a `'simplefin'` branch, nothing here needs to change.
 *
 * Field shapes below (`DashboardAccountSnapshot`/`DashboardTransactionSnapshot`/
 * `DashboardSnapshot`) are a deliberate standalone mirror of the identically-
 * shaped types in `shared/ipc.ts`, not an import of them — same pattern
 * `mcp-server-manager.ts` uses for `McpProcessStatus`/`McpServerState` vs.
 * `shared/ipc.ts`'s `McpServerStatus`/`McpServerState`: it keeps this module
 * unit-testable with plain fakes, independent of the IPC wire contract.
 */

import { getCladCore } from './clad-core.js'
import { createFinancialProvider, missingPlaidPrereqs, providerFingerprint } from './provider-factory.js'
import type { CladConfig, CladProvider } from './config.js'

/**
 * Neither `DummyDataProvider` nor `PlaidAdapter` use this argument
 * meaningfully (see `packages/core/src/providers/dummy.ts` and
 * `packages/plaid-adapter/src/adapter.ts` — both prefix-underscore it).
 * mcp-server passes the calling agent's id here since its tools are
 * per-agent; the dashboard has no agent, it's the human owner's own view, so
 * a fixed constant is all either provider needs.
 */
const USER_ID = 'desktop-dashboard'

/** Fetched per account, then merged/sorted/truncated to `RECENT_TRANSACTIONS_TOTAL` below. */
const RECENT_TRANSACTIONS_PER_ACCOUNT = 25
const RECENT_TRANSACTIONS_TOTAL = 25

export type DashboardProviderState = 'no-provider-configured' | 'ready' | 'error'

export interface DashboardAccountSnapshot {
  id: string
  name: string
  type: 'checking' | 'savings' | 'credit' | 'loan' | 'investment'
  mask?: string
  /** The account's financial institution, when the active provider can resolve one (see `@clad/core`'s `Account.institution` doc comment) — `undefined` for `DummyDataProvider`. */
  institution?: string
  balanceCurrent: number
  balanceAvailable?: number
  currency: string
  stale?: boolean
}

export interface DashboardTransactionSnapshot {
  id: string
  accountId: string
  amount: number
  date: string
  description: string
  merchantName?: string
  category?: string[]
  pending: boolean
  stale?: boolean
}

export interface DashboardSnapshot {
  state: DashboardProviderState
  provider: CladProvider
  accounts: DashboardAccountSnapshot[]
  transactions: DashboardTransactionSnapshot[]
  /** ISO timestamp of the last successful `refresh()` this session, or `null` if none yet. */
  lastRefreshed: string | null
  /** Display-safe (redacted where derived from a thrown provider error). */
  error?: string
}

export interface DashboardDataDeps {
  /** Resolves config fresh on every call, so a Settings change before the next refresh is picked up — same contract as `McpServerManagerDeps.loadConfig`. */
  loadConfig: () => CladConfig
  /** Null when Plaid credentials haven't been saved yet. */
  loadPlaidCredentials: () => { clientId: string; secret: string } | null
  /** Null when passphrase custody isn't resolved yet (e.g. CLI-migration prompt still pending). */
  getActivePassphrase: () => string | null
}

export class DashboardDataStore {
  private accounts: DashboardAccountSnapshot[] = []
  private transactions: DashboardTransactionSnapshot[] = []
  private lastRefreshed: string | null = null
  private lastError: string | undefined

  private cachedProvider: import('@clad/core').FinancialDataProvider | null = null
  private cachedFingerprint: string | null = null

  constructor(private readonly deps: DashboardDataDeps) {}

  /** Pure, synchronous, no network — see module doc comment. Safe to call as often as the renderer likes (e.g. on every mount). */
  getSnapshot(): DashboardSnapshot {
    const config = this.deps.loadConfig()

    if (config.provider === 'plaid') {
      const missing = missingPlaidPrereqs({
        plaidCredentials: this.deps.loadPlaidCredentials(),
        passphrase: this.deps.getActivePassphrase(),
      })
      if (missing.length > 0) {
        return {
          state: 'no-provider-configured',
          provider: config.provider,
          accounts: this.accounts,
          transactions: this.transactions,
          lastRefreshed: this.lastRefreshed,
          error: `The Plaid provider is selected but not fully set up. Missing: ${missing.join('; ')}.`,
        }
      }
    }

    return {
      state: this.lastError ? 'error' : 'ready',
      provider: config.provider,
      accounts: this.accounts,
      transactions: this.transactions,
      lastRefreshed: this.lastRefreshed,
      error: this.lastError,
    }
  }

  /** The only method in this class that ever talks to the provider. */
  async refresh(): Promise<DashboardSnapshot> {
    const config = this.deps.loadConfig()
    const plaidCredentials = this.deps.loadPlaidCredentials()
    const passphrase = this.deps.getActivePassphrase()

    const fingerprint = providerFingerprint({ config, plaidCredentials, passphrase })
    if (fingerprint !== this.cachedFingerprint) {
      // Config/credentials changed since the last refresh (or this is the
      // first one) — drop any cached provider so the next fetch rebuilds it
      // against the current settings rather than silently reusing a stale
      // client/token store.
      this.cachedProvider = null
      this.cachedFingerprint = fingerprint
    }

    if (!this.cachedProvider) {
      const factoryResult = await createFinancialProvider({ config, plaidCredentials, passphrase })
      if (!factoryResult.ok) {
        // Two distinct cases collapse into "not ok" here: (1) the common
        // "plaid selected but credentials/passphrase missing" case, which
        // getSnapshot() already re-derives independently via
        // missingPlaidPrereqs() and takes priority over lastError — nothing
        // to update for that one; (2) a genuine construction failure (e.g.
        // an invalid plaid_env) despite prereqs being present, which
        // getSnapshot() has no other way to learn about — surface it via
        // lastError so it isn't silently swallowed as a bare 'ready' state
        // with no data and no explanation.
        if (missingPlaidPrereqs({ plaidCredentials, passphrase }).length === 0) {
          this.lastError = factoryResult.error
        }
        return this.getSnapshot()
      }
      this.cachedProvider = factoryResult.provider
    }

    try {
      const provider = this.cachedProvider
      const accounts = await provider.getAccounts(USER_ID)
      const perAccountTransactions = await Promise.all(
        accounts.map((account) =>
          provider.getTransactions(USER_ID, account.id, { count: RECENT_TRANSACTIONS_PER_ACCOUNT })
        )
      )

      const recentTransactions = perAccountTransactions
        .flat()
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
        .slice(0, RECENT_TRANSACTIONS_TOTAL)

      this.accounts = accounts.map(toDashboardAccount)
      this.transactions = recentTransactions.map(toDashboardTransaction)
      this.lastRefreshed = new Date().toISOString()
      this.lastError = undefined
    } catch (err) {
      const { redactSecrets } = await getCladCore()
      const message = err instanceof Error ? err.message : String(err)
      // Keep whatever was cached before this failed attempt — "stale data
      // shown honestly beats fresh data that burns quota" extends naturally
      // to "beats no data at all" when a refresh attempt fails outright.
      this.lastError = redactSecrets(message)
    }

    return this.getSnapshot()
  }
}

/** Exported for direct unit testing of the field mapping (see `test/dashboard-data.test.ts`) — same rationale as `@clad/plaid-adapter`'s exported `mapAccount`/`mapTransaction`. */
export function toDashboardAccount(account: import('@clad/core').Account): DashboardAccountSnapshot {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    mask: account.mask,
    institution: account.institution,
    balanceCurrent: account.balance_current,
    balanceAvailable: account.balance_available,
    currency: account.currency,
    stale: account.stale,
  }
}

function toDashboardTransaction(txn: import('@clad/core').Transaction): DashboardTransactionSnapshot {
  return {
    id: txn.id,
    accountId: txn.account_id,
    amount: txn.amount,
    date: txn.date,
    description: txn.description,
    merchantName: txn.merchant_name,
    category: txn.category,
    pending: txn.pending,
    stale: txn.stale,
  }
}
