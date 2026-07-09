/**
 * D2.4 policy editor data layer — reads/validates/writes the policy YAML
 * file that `@clad/mcp-server`'s tool-call gate reads on every request.
 *
 * Ported from `packages/cli/src/commands/ui.ts`'s Express API routes
 * (`GET /api/policy`, `PUT /api/policy`) onto IPC — same two operations
 * (`readPolicy`/`writePolicy` below), same validation strategy (stringify to
 * YAML, write it to a throwaway temp file, run THAT through `parsePolicy` —
 * which validates against `@clad/core`'s ajv policy schema — and only ever
 * overwrite the real `policyPath` file if that succeeds), same error-shape
 * distinction between "not written yet" (`ok: false`, invalid policy or a
 * genuine fs error) and a successful write.
 *
 * Same S0.2 rule as `dashboard-data.ts` / `provider-factory.ts`: `@clad/core`
 * is ESM-only and crashes the CJS main-process bundle on a *static* import,
 * so `parsePolicy` is only ever reached through `getCladCore()` (enforced by
 * the desktop eslint override — see `clad-core.ts`'s module doc). The
 * `PolicyConfig` type reference below uses the inline `import('@clad/core')`
 * form (a `TSImportType`, not an `ImportDeclaration`) for the same reason
 * `provider-factory.ts` does.
 *
 * Policy YAML is NOT secret material (desktop-app.md's standing security
 * checklist item 5 is explicit about this) — no `0600` perms, no
 * `redactSecrets`, no `safeStorage`. It legitimately contains merchant/
 * category names and dollar limits, never credentials or tokens.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { getCladCore } from './clad-core.js'

export type PolicyGetResult =
  | { ok: true; policy: import('@clad/core').PolicyConfig; raw: string }
  | { ok: false; error: string }

export type PolicyWriteResult = { ok: true } | { ok: false; error: string }

/**
 * `GET /api/policy` equivalent — reads the raw YAML text (empty string if
 * the file doesn't exist yet, e.g. a fresh config dir before first bootstrap
 * writes the starter policy) alongside the schema-validated parse of it.
 * `parsePolicy` itself already treats a missing/empty file as `{ agents: {} }`
 * rather than throwing (see `packages/core/src/policy/parser.ts`) — the only
 * `ok: false` case here is a genuine parse/schema-validation failure against
 * whatever is actually on disk right now.
 */
export async function readPolicy(policyPath: string): Promise<PolicyGetResult> {
  try {
    const raw = existsSync(policyPath) ? await readFile(policyPath, 'utf-8') : ''
    const { parsePolicy } = await getCladCore()
    const policy = await parsePolicy(policyPath)
    return { ok: true, policy, raw }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * `PUT /api/policy` equivalent: never trusts the renderer's own in-memory
 * shape. Validates the proposed policy by writing it to a throwaway temp
 * file and running it through the SAME `parsePolicy` schema check the real
 * MCP server gate uses, and only overwrites `policyPath` once that succeeds
 * — an invalid edit never touches the file agents are actually gated
 * against. Uses a fresh `mkdtemp` directory per call (rather than `ui.ts`'s
 * `Date.now()`-suffixed single temp file) so two concurrent saves — or a
 * retried save after a failure — can never collide on the same temp path.
 */
export async function writePolicy(policyPath: string, policy: unknown): Promise<PolicyWriteResult> {
  if (!policy || typeof policy !== 'object') {
    return { ok: false, error: 'Request body must include a "policy" object' }
  }

  const yamlContent = stringifyYaml(policy, { lineWidth: 0 })
  const tmpDir = await mkdtemp(join(tmpdir(), 'clad-desktop-policy-validate-'))
  const tmpPath = join(tmpDir, 'policy.yaml')
  try {
    await writeFile(tmpPath, yamlContent, 'utf-8')
    const { parsePolicy } = await getCladCore()
    await parsePolicy(tmpPath) // throws if invalid — nothing below runs in that case
    await writeFile(policyPath, yamlContent, 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
