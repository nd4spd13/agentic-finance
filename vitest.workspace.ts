import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core/vitest.config.ts',
  'packages/mcp-server/vitest.config.ts',
])
