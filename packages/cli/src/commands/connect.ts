/**
 * clad connect — link a bank account through Plaid or SimpleFIN.
 *
 * Drives the CRS-25 WP4 Link connect flow (Plaid) and persists the resulting
 * access token, encrypted at rest, via `SqliteTokenStore`. This command is
 * intentionally thin: all of the Plaid flow logic (and its tests) live in
 * `@clad/plaid-adapter`'s `runLinkFlow` / `runSandboxAutoFlow`.
 *
 * `--provider simplefin` (SF6) drives a much simpler paste-a-token flow: the
 * SimpleFIN Bridge protocol has no OAuth-style browser handoff at all — the
 * user generates a one-time **setup token** on the Bridge's own site and
 * pastes it here. Unlike Plaid, there is no separate "flow" module in
 * `@clad/simplefin-adapter` to delegate to (the plan never called for one —
 * claim + store + summarize is only a few lines), so that logic lives
 * directly in this file, composing `claimSetupToken` (claim.ts),
 * `fetchAccounts`/`mapAccountSet` (client.ts/mapping.ts), and `SimpleFinCache`
 * (cache.ts) from `@clad/simplefin-adapter`.
 *
 * Security:
 *  - Plaid credentials (`PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV`) come
 *    from the environment only and are never written to config.json.
 *  - Neither the Plaid access token nor the SimpleFIN access URL is ever
 *    printed, logged, or embedded in an error message. Only institution +
 *    masked account metadata is shown. Every SimpleFIN failure surfaces
 *    through the `SimpleFinError` hierarchy (`@clad/simplefin-adapter`),
 *    whose messages are already redacted at construction; any other error is
 *    additionally passed through `redactSecrets` defensively before display.
 */

import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'
import {
  SqliteTokenStore,
  runLinkFlow,
  runSandboxAutoFlow,
  LinkFlowError,
  type LinkFlowResult,
} from '@clad/plaid-adapter'
import {
  claimSetupToken,
  fetchAccounts,
  mapAccountSet,
  MAX_WINDOW_SECONDS,
  SimpleFinCache,
  SimpleFinError,
  type FetchLike,
} from '@clad/simplefin-adapter'
import { redactSecrets, TokenStoreKeyError, type Account } from '@clad/core'
import { ensureConfigDir, getConfigPath, loadConfig, saveConfig } from '../config.js'

export interface ConnectOptions {
  sandboxAuto?: boolean
  use?: boolean
  /** Which provider to connect. Defaults to `'plaid'` (unchanged CLI behavior). */
  provider?: string
  /**
   * Test-only seam: injectable `fetch` for the SimpleFIN claim/accounts
   * calls. Defaults to `globalThis.fetch`. Never set by the `clad` binary
   * itself — commander has no flag for this.
   */
  fetch?: FetchLike
  /**
   * Test-only seam: injectable stdin for interactive prompts (setup token /
   * passphrase). Defaults to `process.stdin`.
   */
  input?: NodeJS.ReadableStream
  /**
   * Test-only seam: injectable stdout for interactive prompts. Defaults to
   * `process.stdout`.
   */
  output?: NodeJS.WritableStream
}

const SUPPORTED_PROVIDERS = ['plaid', 'simplefin'] as const
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

export async function connectCommand(opts: ConnectOptions = {}): Promise<void> {
  const provider = opts.provider ?? 'plaid'

  if (!isSupportedProvider(provider)) {
    console.error(
      `clad connect: unsupported --provider "${provider}". Expected one of: ` +
        `${SUPPORTED_PROVIDERS.join(', ')}.`
    )
    process.exitCode = 1
    return
  }

  if (provider === 'simplefin') {
    return connectSimpleFin(opts)
  }
  return connectPlaid(opts)
}

function isSupportedProvider(value: string): value is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------
// Plaid
// ---------------------------------------------------------------------

async function connectPlaid(opts: ConnectOptions): Promise<void> {
  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  const env = process.env.PLAID_ENV

  const missing: string[] = []
  if (!clientId) missing.push('PLAID_CLIENT_ID')
  if (!secret) missing.push('PLAID_SECRET')
  if (!env) missing.push('PLAID_ENV')
  if (missing.length > 0) {
    console.error(
      `clad connect: missing required environment variable(s): ${missing.join(', ')}.\n` +
        'Set them in your shell before running (they are never written to config.json).'
    )
    process.exitCode = 1
    return
  }

  const basePath = PlaidEnvironments[env as string]
  if (!basePath) {
    console.error(
      `clad connect: unsupported PLAID_ENV "${env}". Expected one of: ` +
        `${Object.keys(PlaidEnvironments).join(', ')}.`
    )
    process.exitCode = 1
    return
  }

  if (opts.sandboxAuto && env !== 'sandbox') {
    console.error('clad connect: --sandbox-auto requires PLAID_ENV=sandbox.')
    process.exitCode = 1
    return
  }

  const passphrase =
    process.env.CLAD_TOKEN_PASSPHRASE ??
    (await promptHidden(
      'Token store passphrase (used to encrypt Plaid tokens at rest): ',
      opts.input,
      opts.output
    ))
  if (!passphrase) {
    console.error('clad connect: a non-empty passphrase is required to encrypt the token store.')
    process.exitCode = 1
    return
  }

  const config = loadConfig()
  ensureConfigDir()

  const client = new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': clientId,
          'PLAID-SECRET': secret,
        },
      },
    })
  )

  let tokenStore: SqliteTokenStore
  try {
    tokenStore = new SqliteTokenStore({ dbPath: config.plaid_db, passphrase })
  } catch (error) {
    console.error(`clad connect: ${describePlaidError(error)}`)
    process.exitCode = 1
    return
  }

  try {
    if (opts.sandboxAuto) {
      console.error('clad connect: creating a sandbox Item (no browser)…')
    } else {
      console.error('clad connect: opening your browser to complete Plaid Link…')
    }

    const result: LinkFlowResult = opts.sandboxAuto
      ? await runSandboxAutoFlow({ client, tokenStore })
      : await runLinkFlow({ client, tokenStore })

    printPlaidResult(result)

    if (opts.use) {
      saveConfig({ ...config, provider: 'plaid' })
      console.log("\nProvider set to 'plaid' in your config. Restart `clad serve` to use it.")
    } else {
      console.log("\nTo route agent traffic through Plaid, set the provider to 'plaid':")
      console.log('  • re-run with:  clad connect --use')
      console.log(`  • or edit ${getConfigPath()} and set "provider": "plaid"`)
    }
  } catch (error) {
    console.error(`clad connect: ${describePlaidError(error)}`)
    process.exitCode = 1
  } finally {
    tokenStore.close()
  }
}

function printPlaidResult(result: LinkFlowResult): void {
  console.log(`\n✓ Connected: ${result.institutionName}`)
  console.log(`  Item: ${result.itemId}`)
  if (result.accounts.length === 0) {
    console.log('  (No per-account details were returned for this connection.)')
    return
  }
  console.log('  Linked accounts:')
  for (const account of result.accounts) {
    const masked = account.mask ? `••••${account.mask}` : '••••'
    const kind = account.subtype ?? account.type ?? 'account'
    console.log(`    - ${account.name} (${kind}) ${masked}`)
  }
}

/**
 * Produces a user-facing error string. `LinkFlowError` messages are already
 * redacted; everything else is run through `redactSecrets` defensively before
 * display (e.g. a raw Plaid SDK/axios error that could embed a secret).
 */
function describePlaidError(error: unknown): string {
  if (error instanceof LinkFlowError) return error.message
  if (error instanceof TokenStoreKeyError) return error.message
  if (error instanceof Error) return redactSecrets(error.message)
  return 'unknown error'
}

// ---------------------------------------------------------------------
// SimpleFIN
// ---------------------------------------------------------------------

const SIMPLEFIN_CREATE_URL = 'https://bridge.simplefin.org/simplefin/create'
const SIMPLEFIN_DEMO_URL = 'https://beta-bridge.simplefin.org/info/developers'

/** Per-account summary line printed after a successful connect. Contains no secret material. */
interface SimpleFinAccountSummary {
  id: string
  name: string
  institution?: string
}

async function connectSimpleFin(opts: ConnectOptions): Promise<void> {
  const passphrase =
    process.env.CLAD_TOKEN_PASSPHRASE ??
    (await promptHidden(
      'Token store passphrase (used to encrypt SimpleFIN tokens at rest): ',
      opts.input,
      opts.output
    ))
  if (!passphrase) {
    console.error('clad connect: a non-empty passphrase is required to encrypt the token store.')
    process.exitCode = 1
    return
  }

  const config = loadConfig()
  ensureConfigDir()

  console.log('\nclad connect: SimpleFIN Bridge')
  console.log('  1. Generate a setup token:')
  console.log(`       ${SIMPLEFIN_CREATE_URL}`)
  console.log(`     (a free demo token is available at ${SIMPLEFIN_DEMO_URL})`)
  console.log('  2. Paste the setup token below. It is one-time use — pasting it here')
  console.log('     consumes it, so this prompt does not need to hide your input.\n')

  const setupToken = await promptVisible('SimpleFIN setup token: ', opts.input, opts.output)
  if (!setupToken) {
    console.error('clad connect: a setup token is required.')
    process.exitCode = 1
    return
  }

  let tokenStore: SqliteTokenStore
  try {
    tokenStore = new SqliteTokenStore({ dbPath: config.simplefin_db, passphrase })
  } catch (error) {
    console.error(`clad connect: ${describeSimpleFinError(error)}`)
    process.exitCode = 1
    return
  }

  try {
    console.error('clad connect: claiming SimpleFIN setup token…')
    // Never pass `setupToken`/`accessUrl` to anything but claimSetupToken,
    // tokenStore.saveItem, and fetchAccounts below — no console.log/error
    // call in this branch is allowed to interpolate either.
    const accessUrl = await claimSetupToken(setupToken, { fetch: opts.fetch })

    const itemId = `simplefin-${randomUUID()}`
    // The setup token is now consumed; the access URL is the only copy of
    // this credential that will ever exist. Persist it before attempting
    // anything else so a failure below can never lose it.
    tokenStore.saveItem({
      itemId,
      institutionName: 'SimpleFIN Bridge',
      accessToken: accessUrl,
    })

    console.log(`\n✓ Connected: SimpleFIN Bridge`)
    console.log(`  Item: ${itemId}`)

    let accounts: SimpleFinAccountSummary[] | undefined
    try {
      console.error('clad connect: fetching an initial account summary…')
      accounts = await fetchInitialSimpleFinSummary(itemId, accessUrl, config.simplefin_db, passphrase, opts.fetch)
    } catch (error) {
      console.log(
        '  Could not fetch an initial account summary yet: ' + describeSimpleFinError(error)
      )
      console.log(
        '  Your SimpleFIN credentials were saved — this will retry automatically the next ' +
          'time data is requested (e.g. via clad_get_balances).'
      )
    }

    if (accounts) {
      printSimpleFinSummary(accounts)
    }

    if (opts.use) {
      saveConfig({ ...config, provider: 'simplefin' })
      console.log("\nProvider set to 'simplefin' in your config. Restart `clad serve` to use it.")
    } else {
      console.log("\nTo route agent traffic through SimpleFIN, set the provider to 'simplefin':")
      console.log('  • re-run with:  clad connect --provider simplefin --use')
      console.log(`  • or edit ${getConfigPath()} and set "provider": "simplefin"`)
    }
  } catch (error) {
    console.error(`clad connect: ${describeSimpleFinError(error)}`)
    process.exitCode = 1
  } finally {
    tokenStore.close()
  }
}

/**
 * Fetches this item's accounts once (widest protocol-allowed window,
 * `pending: true` — mirrors `SimpleFinAdapter.refreshItemIfDue`) and records
 * the result in the shared cache DB, so the very first `clad_get_balances`
 * call after connecting reads from cache instead of burning a second request
 * against the Bridge's daily quota. Returns a summary containing no secret
 * material — never the access URL, never a raw un-namespaced account id.
 */
async function fetchInitialSimpleFinSummary(
  itemId: string,
  accessUrl: string,
  dbPath: string,
  passphrase: string,
  fetchImpl: FetchLike | undefined
): Promise<SimpleFinAccountSummary[]> {
  const cache = new SimpleFinCache({ dbPath, passphrase })
  try {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const accountSet = await fetchAccounts(accessUrl, {
      fetch: fetchImpl,
      startDate: Math.max(0, nowSeconds - MAX_WINDOW_SECONDS),
      endDate: nowSeconds,
      pending: true,
    })
    const { accounts, transactions } = mapAccountSet(accountSet)
    cache.recordFetch(itemId, accounts, transactions)
    return accounts.map((account: Account) => ({
      id: account.id,
      name: account.name,
      institution: account.institution,
    }))
  } finally {
    cache.close()
  }
}

function printSimpleFinSummary(accounts: SimpleFinAccountSummary[]): void {
  if (accounts.length === 0) {
    console.log('  (No accounts were returned for this connection.)')
    return
  }

  const institutions = Array.from(
    new Set(accounts.map((a) => a.institution).filter((name): name is string => Boolean(name)))
  )
  if (institutions.length > 0) {
    console.log(`  Institution(s): ${institutions.join(', ')}`)
  }
  console.log('  Linked accounts:')
  for (const account of accounts) {
    console.log(`    - ${account.name} ${maskSimpleFinAccountId(account.id)}`)
  }
}

/**
 * SimpleFIN accounts have no card-style `mask` field (unlike Plaid). Masks
 * the mapped, namespaced account id (`simplefin:{raw}`) down to its last 4
 * characters instead, so the printed summary never shows a full account
 * identifier — mirroring the `••••{mask}` shape `printPlaidResult` uses.
 */
function maskSimpleFinAccountId(accountId: string): string {
  const raw = accountId.startsWith('simplefin:') ? accountId.slice('simplefin:'.length) : accountId
  if (raw.length <= 4) return '••••'
  return `••••${raw.slice(-4)}`
}

/**
 * Produces a user-facing error string for the SimpleFIN connect path.
 * `SimpleFinError` subclasses (claim/decode/request/response/HTTP failures)
 * and `TokenStoreKeyError` already carry pre-sanitized, secret-free messages
 * (see their respective modules); anything else is passed through
 * `redactSecrets` defensively.
 */
function describeSimpleFinError(error: unknown): string {
  if (error instanceof SimpleFinError) return error.message
  if (error instanceof TokenStoreKeyError) return error.message
  if (error instanceof Error) return redactSecrets(error.message)
  return 'unknown error'
}

// ---------------------------------------------------------------------
// Shared prompt helpers
// ---------------------------------------------------------------------

/**
 * Reads a line from stdin without echoing it, for passphrase entry. Falls
 * back to a normal (non-terminal) prompt when `input` is not a real TTY —
 * piped/injected input (scripts, tests) has nothing to visually echo in the
 * first place, and forcing keypress-decoding `terminal: true` mode onto a
 * non-tty stream (as this function used to do unconditionally) makes it
 * consume input unpredictably when driven by a fake stdin in tests.
 */
async function promptHidden(
  prompt: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): Promise<string> {
  const isRealTty = Boolean((input as { isTTY?: boolean }).isTTY)
  const rl = createInterface({ input, output, terminal: isRealTty })
  const rlInternal = rl as unknown as { _writeToOutput: (chunk: string) => void }
  let muted = false

  rlInternal._writeToOutput = (chunk: string): void => {
    if (!muted) {
      output.write(chunk)
    }
  }

  return new Promise<string>((resolve) => {
    output.write(prompt)
    muted = true
    rl.question('', (answer) => {
      muted = false
      rl.close()
      output.write('\n')
      resolve(answer.trim())
    })
  })
}

/**
 * Reads a line from stdin with normal echo — used for the SimpleFIN setup
 * token, which is one-time-use and safe to display as it's typed/pasted.
 */
async function promptVisible(
  prompt: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): Promise<string> {
  const rl = createInterface({ input, output })
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}
