/**
 * Matches Plaid token identifiers: `access-`, `public-`, and `link-` tokens,
 * each formatted as `<prefix>-<env>-<opaque-id>` where `<env>` is one of
 * Plaid's environments and `<opaque-id>` is a hyphenated alphanumeric string.
 */
const PLAID_TOKEN_PATTERN =
  /\b(?:access|public|link)-(?:sandbox|development|production)-[A-Za-z0-9-]+/g

/**
 * Field names that indicate the adjacent value is secret-like: token,
 * secret, api key, passphrase, password (case-insensitive, with `-`/`_`
 * separators optional, e.g. `access_token`, `PLAID-SECRET`, `apiKey`).
 */
const SECRET_FIELD_NAME = '(?:secret|access[_-]?token|api[_-]?key|passphrase|password)'

/** Optional quote (possibly backslash-escaped) wrapping a JSON field name. */
const OPTIONAL_QUOTE = '(?:\\\\?["\'])?'

const SECRET_FIELD_PREFIX = `(${OPTIONAL_QUOTE}[\\w-]*${SECRET_FIELD_NAME}[\\w-]*${OPTIONAL_QUOTE}\\s*[:=]\\s*)`

/**
 * Matches `"<field>": "<value>"` pairs whose value is delimited by a
 * backslash-escaped quote (`\"..."\"`) — the shape produced when a JSON
 * object has been stringified and then embedded as a string value inside
 * another JSON object (e.g. an axios error's `config.data`).
 */
const SECRET_FIELD_ESCAPED_QUOTES = new RegExp(
  `${SECRET_FIELD_PREFIX}\\\\"((?:[^"\\\\]|\\\\.)*?)\\\\"`,
  'gi'
)

/**
 * Matches `"<field>": "<value>"` pairs whose value is delimited by plain
 * double quotes — plain strings and top-level JSON.stringify output.
 */
const SECRET_FIELD_PLAIN_QUOTES = new RegExp(`${SECRET_FIELD_PREFIX}"((?:[^"\\\\]|\\\\.)*)"`, 'gi')

/**
 * Redacts Plaid access/public/link tokens and secret-like key/value pairs
 * from arbitrary text (plain strings, JSON.stringify'd errors, or nested
 * error messages such as those produced by axios). Safe to run on any
 * outbound string before logging, throwing, or persisting it.
 */
export function redactSecrets(input: string): string {
  if (!input) return input

  let output = input.replace(PLAID_TOKEN_PATTERN, '[REDACTED]')
  // Escaped-quote pairs must be redacted before plain-quote pairs, otherwise
  // the plain-quote pattern's negated character class would stop early at
  // the literal backslash preceding an escaped quote.
  output = output.replace(
    SECRET_FIELD_ESCAPED_QUOTES,
    (_match, prefix: string) => `${prefix}\\"[REDACTED]\\"`
  )
  output = output.replace(
    SECRET_FIELD_PLAIN_QUOTES,
    (_match, prefix: string) => `${prefix}"[REDACTED]"`
  )

  return output
}
