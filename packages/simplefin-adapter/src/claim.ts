/**
 * SimpleFIN Bridge setup-token claim flow (SF2).
 *
 * A SimpleFIN "setup token" is a base64-encoded one-time **claim URL**.
 * Decoding it and POSTing to that URL (`Content-Length: 0`, empty body)
 * exchanges the token for an **access URL** — a URL with embedded HTTP
 * basic-auth credentials (`https://user:pass@host/path`) that is the actual
 * long-lived credential for the Bridge's `/accounts` endpoint. The claim is
 * one-time: a second POST to the same claim URL fails (non-2xx).
 *
 * Pure and side-effect-free beyond the injected `fetch` call: nothing here
 * logs, caches, or persists anything, and the only global read is
 * `globalThis.fetch`, used solely as the default when no `fetch` option is
 * supplied. Persisting the returned access URL (encrypted at rest) is the
 * caller's responsibility — see the plan's `token-store.ts` task (SF5).
 *
 * Security invariant: no thrown message here ever contains the access URL,
 * the claim URL, or raw response-body text. The claim URL is not itself a
 * credential per the protocol, but response bodies are never echoed into
 * errors anyway — a broken/partial body could still look secret-shaped.
 */

import { SimpleFinClaimError, SimpleFinTokenError } from './errors.js'

/** The shape of the global `fetch` function, injectable for tests. */
export type FetchLike = typeof fetch

export interface ClaimSetupTokenOptions {
  /**
   * Fetch implementation to use for the claim POST. Defaults to
   * `globalThis.fetch`. Unit tests must always supply a fake here — no test
   * in this package should touch the network.
   */
  fetch?: FetchLike
}

/** Matches a base64 string (standard alphabet, optional `=` padding). */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Decodes a SimpleFIN setup token into its embedded claim URL string.
 *
 * Pure: no I/O. Throws {@link SimpleFinTokenError} if the token is empty,
 * not valid base64, or decodes to something other than a well-formed
 * `http(s)` URL.
 */
export function decodeSetupToken(setupToken: string): string {
  const trimmed = setupToken.trim()
  if (trimmed.length === 0) {
    throw new SimpleFinTokenError('SimpleFIN setup token is empty.')
  }

  // `Buffer.from(_, 'base64')` silently ignores characters outside the
  // base64 alphabet instead of throwing, so a malformed token must be
  // rejected explicitly rather than relying on decode failure.
  if (!BASE64_PATTERN.test(trimmed)) {
    throw new SimpleFinTokenError('SimpleFIN setup token is not valid base64.')
  }

  const decoded = Buffer.from(trimmed, 'base64').toString('utf-8')

  const claimUrl = tryParseUrl(decoded)
  if (!claimUrl) {
    throw new SimpleFinTokenError('Decoded SimpleFIN setup token is not a valid URL.')
  }
  if (claimUrl.protocol !== 'https:' && claimUrl.protocol !== 'http:') {
    throw new SimpleFinTokenError(
      'Decoded SimpleFIN setup token URL must use the http or https scheme.'
    )
  }

  return claimUrl.toString()
}

/**
 * Decodes a setup token and performs the one-time claim POST, resolving with
 * the access URL. Throws {@link SimpleFinTokenError} for a malformed token
 * (see {@link decodeSetupToken}) or {@link SimpleFinClaimError} if the claim
 * itself fails: a network error, a non-2xx response (e.g. the token was
 * already claimed), or a 2xx response whose body isn't a valid access URL.
 */
export async function claimSetupToken(
  setupToken: string,
  options: ClaimSetupTokenOptions = {}
): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken)
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new SimpleFinClaimError(
      'No fetch implementation is available; pass options.fetch explicitly.'
    )
  }

  let response: Response
  try {
    response = await fetchImpl(claimUrl, {
      method: 'POST',
      headers: { 'Content-Length': '0' },
      body: '',
    })
  } catch {
    // Deliberately does not include the caught error's message: fetch
    // network-failure messages can embed the request URL, and while the
    // claim URL isn't the credential, keeping this static avoids ever having
    // to reason about it case by case.
    throw new SimpleFinClaimError('Failed to reach the SimpleFIN claim URL.')
  }

  if (!response.ok) {
    // One-time-use semantics mean a reused token also lands here (typically
    // as a 403/410), so the message calls that out rather than implying a
    // transient failure.
    throw new SimpleFinClaimError(
      `SimpleFIN claim request failed with HTTP ${response.status}. Setup tokens are ` +
        'one-time use — this may mean the token was already claimed or has expired.'
    )
  }

  const body = (await response.text()).trim()
  if (body.length === 0) {
    throw new SimpleFinClaimError('SimpleFIN claim response body was empty.')
  }

  const accessUrl = tryParseUrl(body)
  if (!accessUrl) {
    throw new SimpleFinClaimError('SimpleFIN claim response did not contain a valid access URL.')
  }
  if (accessUrl.protocol !== 'https:' && accessUrl.protocol !== 'http:') {
    throw new SimpleFinClaimError('SimpleFIN access URL must use the http or https scheme.')
  }

  return accessUrl.toString()
}

function tryParseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}
