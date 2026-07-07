#!/usr/bin/env node
/**
 * Dev-only: read back what `clad connect` linked, so you can eyeball the data.
 *
 * Reuses the SAME encrypted token store + cache DB that the CLI writes
 * (`plaid_db` in your config, default ~/.clad/plaid.sqlite), then calls the
 * PlaidAdapter exactly like the MCP server would and prints accounts,
 * balances, recent transactions, and recurring charges.
 *
 * Read-only against your local store; the only network calls are to Plaid.
 * Nothing here is committed to product behavior — it just mirrors the runtime
 * path for a human to look at. Never prints the access token.
 *
 * Usage (from repo root, after `pnpm build`):
 *   set -a; . ./.env.sandbox; set +a
 *   export CLAD_CONFIG_DIR="$HOME/.clad-sandbox"   # match what you used for connect
 *   node scripts/plaid-inspect.mjs
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
// Import the built package directly by path — this script lives outside any
// package, so there's no node_modules symlink for the `@clad/plaid-adapter`
// bare specifier to resolve. Requires `pnpm build` first.
import {
  PlaidAdapter,
  SqliteTokenStore,
  createPlaidClient,
} from '../packages/plaid-adapter/dist/index.js'

function fail(msg) {
  console.error(`plaid-inspect: ${msg}`)
  process.exit(1)
}

const clientId = process.env.PLAID_CLIENT_ID
const secret = process.env.PLAID_SECRET
const env = process.env.PLAID_ENV
const passphrase = process.env.CLAD_TOKEN_PASSPHRASE
if (!clientId || !secret || !env) fail('set PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (source .env.sandbox)')
if (!passphrase) fail('CLAD_TOKEN_PASSPHRASE is required and must match the one used for `clad connect`')

// Resolve plaid_db the same way the CLI does: config.json if present, else default.
const configDir = process.env.CLAD_CONFIG_DIR ?? join(homedir(), '.clad')
const configPath = join(configDir, 'config.json')
let dbPath = join(configDir, 'plaid.sqlite')
if (existsSync(configPath)) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
  if (cfg.plaid_db) dbPath = resolve(String(cfg.plaid_db).replace('~', homedir()))
}
if (!existsSync(dbPath)) fail(`no token store at ${dbPath} — run \`clad connect\` first (same CLAD_CONFIG_DIR)`)

console.log(`Using token store: ${dbPath}\n`)

const client = createPlaidClient({ clientId, secret, env })
const tokenStore = new SqliteTokenStore({ dbPath, passphrase })
const adapter = new PlaidAdapter({ client, tokenStore, dbPath })
const USER = 'local'

const money = (n) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`)

try {
  const items = tokenStore.listItems()
  console.log(`Linked items: ${items.length}`)
  for (const it of items) console.log(`  • ${it.institutionName} (item ${it.itemId})`)
  console.log('')

  const accounts = await adapter.getAccounts(USER)
  console.log(`=== Accounts (${accounts.length}) ===`)
  for (const a of accounts) {
    const stale = a.stale ? '  [STALE — served from cache]' : ''
    console.log(`  ${a.name}  [${a.type}${a.subtype ? '/' + a.subtype : ''}]  id=${a.id}${stale}`)
  }
  console.log('')

  for (const a of accounts) {
    console.log(`=== ${a.name} (${a.id}) ===`)
    try {
      const bal = await adapter.getBalance(USER, a.id)
      console.log(
        `  Balance: available ${money(bal.available ?? 0)} | current ${money(bal.current ?? 0)} ${bal.currency ?? ''}${bal.stale ? '  [STALE]' : ''}`
      )
    } catch (e) {
      console.log(`  Balance: (error) ${e?.message ?? e}`)
    }

    try {
      const txns = await adapter.getTransactions(USER, a.id, { count: 5 })
      console.log(`  Recent transactions (${txns.length}, newest first):`)
      for (const t of txns) {
        const pend = t.pending ? ' (pending)' : ''
        console.log(`    ${t.date}  ${money(t.amount)}  ${t.description}${pend}`)
      }
    } catch (e) {
      console.log(`  Transactions: (error) ${e?.message ?? e}`)
    }

    try {
      const rec = await adapter.getRecurringCharges(USER, a.id)
      if (rec.length) {
        console.log(`  Recurring charges (${rec.length}):`)
        for (const r of rec) {
          console.log(`    ${money(r.amount)} ${r.frequency}  ${r.description}  next=${r.next_date ?? '?'}`)
        }
      }
    } catch (e) {
      console.log(`  Recurring: (error) ${e?.message ?? e}`)
    }
    console.log('')
  }
} finally {
  tokenStore.close()
}
