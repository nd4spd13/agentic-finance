import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core/vitest.config.ts',
  'packages/mcp-server/vitest.config.ts',
  'packages/plaid-adapter/vitest.config.ts',
  'packages/simplefin-adapter/vitest.config.ts',
  'packages/cli/vitest.config.ts',
  'packages/desktop/vitest.config.ts',
])
