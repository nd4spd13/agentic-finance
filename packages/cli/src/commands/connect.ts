/**
 * clad connect — link a bank account through Plaid.
 *
 * Drives the CRS-25 WP4 Link connect flow and persists the resulting access
 * token, encrypted at rest, via `SqliteTokenStore`. This command is
 * intentionally thin: all of the flow logic (and its tests) live in
 * `@clad/plaid-adapter`'s `runLinkFlow` / `runSandboxAutoFlow`.
 *
 * Security:
 *  - Plaid credentials (`PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV`) come
 *    from the environment only and are never written to config.json.
 *  - The access token is never printed; only institution + masked account
 *    metadata is shown. Any Plaid/flow error is surfaced via `LinkFlowError`,
 *    whose message is already run through `redactSecrets`.
 */

import { createInterface } from 'node:readline'
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'
import {
  SqliteTokenStore,
  runLinkFlow,
  runSandboxAutoFlow,
  LinkFlowError,
  type LinkFlowResult,
} from '@clad/plaid-adapter'
import { redactSecrets } from '@clad/core'
import { ensureConfigDir, getConfigPath, loadConfig, saveConfig } from '../config.js'

export interface ConnectOptions {
  sandboxAuto?: boolean
  use?: boolean
}

export async function connectCommand(opts: ConnectOptions = {}): Promise<void> {
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
    (await promptHidden('Token store passphrase (used to encrypt Plaid tokens at rest): '))
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
    console.error(`clad connect: ${describeError(error)}`)
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

    printResult(result)

    if (opts.use) {
      saveConfig({ ...config, provider: 'plaid' })
      console.log("\nProvider set to 'plaid' in your config. Restart `clad serve` to use it.")
    } else {
      console.log("\nTo route agent traffic through Plaid, set the provider to 'plaid':")
      console.log('  • re-run with:  clad connect --use')
      console.log(`  • or edit ${getConfigPath()} and set "provider": "plaid"`)
    }
  } catch (error) {
    console.error(`clad connect: ${describeError(error)}`)
    process.exitCode = 1
  } finally {
    tokenStore.close()
  }
}

function printResult(result: LinkFlowResult): void {
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
function describeError(error: unknown): string {
  if (error instanceof LinkFlowError) return error.message
  if (error instanceof Error) return redactSecrets(error.message)
  return 'unknown error'
}

/**
 * Reads a line from stdin without echoing it, for passphrase entry. Falls back
 * to a normal prompt if stdin is not a TTY (e.g. piped input in scripts).
 */
async function promptHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const rlInternal = rl as unknown as { _writeToOutput: (chunk: string) => void }
  let muted = false

  rlInternal._writeToOutput = (chunk: string): void => {
    if (!muted) {
      process.stdout.write(chunk)
    }
  }

  return new Promise<string>((resolve) => {
    process.stdout.write(prompt)
    muted = true
    rl.question('', (answer) => {
      muted = false
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}
