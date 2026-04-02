/**
 * clad ui — local React policy editor
 *
 * Starts an Express server on localhost:3456 (configurable via --port).
 * Serves the static React SPA and two API routes:
 *   GET  /api/policy  → reads policy file, returns { policy, raw }
 *   PUT  /api/policy  → validates JSON against schema, writes YAML to disk
 *
 * Opens the browser automatically after server starts.
 */

import express, { Request, Response } from 'express'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { parsePolicy } from '@clad/core'
import { loadConfig } from '../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function getStaticDir(): string {
  // packages/cli/dist/commands/ → packages/cli/static/
  return resolve(__dirname, '../../static')
}

export async function uiCommand(opts: { port: number }): Promise<void> {
  const config = loadConfig()
  const policyPath = process.env.CLAD_POLICY_PATH ?? config.policy_path

  const app = express()
  app.use(express.json({ limit: '1mb' }))

  // ── GET /api/policy ──────────────────────────────────────────────────────
  app.get('/api/policy', async (_req: Request, res: Response) => {
    try {
      let raw = ''
      if (existsSync(policyPath)) {
        raw = await readFile(policyPath, 'utf-8')
      }
      const policy = await parsePolicy(policyPath)
      res.json({ policy, raw })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: msg })
    }
  })

  // ── PUT /api/policy ──────────────────────────────────────────────────────
  app.put('/api/policy', async (req: Request, res: Response) => {
    const { policy } = req.body as { policy: unknown }
    if (!policy || typeof policy !== 'object') {
      res.status(400).json({ error: 'Request body must include a "policy" object' })
      return
    }

    // Write to a temp file and validate via parsePolicy (reuses existing schema validation)
    const tmpPath = join(tmpdir(), `clad-policy-validate-${Date.now()}.yaml`)
    try {
      const yamlContent = stringifyYaml(policy, { lineWidth: 0 })
      await writeFile(tmpPath, yamlContent, 'utf-8')
      await parsePolicy(tmpPath) // throws if invalid
      await writeFile(policyPath, yamlContent, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Distinguish validation errors from write errors
      if (msg.includes('Policy validation failed') || msg.includes('Failed to parse YAML')) {
        res.status(422).json({ error: msg })
      } else {
        res.status(500).json({ error: msg })
      }
    } finally {
      unlink(tmpPath).catch(() => undefined)
    }
  })

  // ── Static SPA ────────────────────────────────────────────────────────────
  const staticDir = getStaticDir()
  app.use(express.static(staticDir))

  // SPA fallback
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(resolve(staticDir, 'index.html'))
  })

  // ── Start server ──────────────────────────────────────────────────────────
  const { port } = opts
  app.listen(port, async () => {
    const url = `http://localhost:${port}`
    console.log(`Clad UI running at ${url}`)
    console.log(`Policy file: ${policyPath}`)
    try {
      const { default: open } = await import('open')
      await open(url)
    } catch {
      console.log(`Open your browser at ${url}`)
    }
  })
}
