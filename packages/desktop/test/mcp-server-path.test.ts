import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolveMcpServerEntry } from '../src/main/lib/mcp-server-path.js'

describe('resolveMcpServerEntry', () => {
  it('resolves to an existing server.js built from @clad/mcp-server', () => {
    const entry = resolveMcpServerEntry()

    expect(entry.endsWith('server.js')).toBe(true)
    expect(existsSync(entry)).toBe(true)
  })
})
