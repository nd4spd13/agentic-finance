// Simple static file server for previewing the Clad UI
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 3456

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

createServer(async (req, res) => {
  // Fake API response for preview
  if (req.url === '/api/policy') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      policy: {
        agents: {
          'spending-agent': {
            description: 'Full-featured spending control agent',
            permissions: {
              accounts: { visible: ['checking', 'savings', 'credit'], balance: true, account_number: false },
              transactions: { read: true, lookback_days: 90, amount_visibility_cap: 5000 },
              spending: { max_per_transaction: 500, max_daily: 2000, merchants: { allow: ['Whole Foods', 'Amazon'] } },
              escalation: { triggers: [{ amount_exceeds: 1000 }, { new_merchant: true }], channel: 'cli', timeout: '5m', default_on_timeout: 'deny' },
              schedule: { active_hours: '09:00-22:00', timezone: 'America/New_York' },
              audit: { log_all_queries: true, retention: '90d' }
            }
          },
          'viewer-agent': {
            description: 'Read-only viewer agent',
            permissions: {
              accounts: { visible: ['checking'], balance: true },
              transactions: { read: true, lookback_days: 30 }
            }
          }
        },
        global: { max_total_daily_spend: 5000, max_concurrent_agents: 5, max_pending_escalations: 10 }
      },
      raw: ''
    }))
    return
  }

  if (req.method === 'PUT' && req.url === '/api/policy') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  const filePath = join(__dirname, req.url === '/' ? 'index.html' : req.url)
  try {
    const data = await readFile(filePath)
    const ext = extname(filePath)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' })
    res.end(data)
  } catch {
    const html = await readFile(join(__dirname, 'index.html'))
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  }
}).listen(PORT, () => {
  console.log(`Clad UI preview running at http://localhost:${PORT}`)
})
