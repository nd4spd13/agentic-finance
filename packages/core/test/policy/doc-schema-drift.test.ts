/**
 * Doc ↔ Schema drift tests — CRS-49
 *
 * Extracts every YAML policy code block from the documentation markdown files,
 * writes each to a temp file, and validates it against the JSON schema via
 * parsePolicy(). If a doc example drifts from the real schema, the test fails.
 *
 * Only *complete* policy blocks (those containing a top-level `agents:` key)
 * are tested — inline snippets showing a single field are skipped.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const docsDir = join(__dirname, '../../../../packages/docs')
const tmpDir = join(__dirname, '../../../../.tmp-doc-schema-tests')

// Markdown files containing policy YAML examples
const DOC_FILES = [
  'index.md',
  'getting-started.md',
  'starter-policies.md',
  'policy-reference.md',
  'integration-guides.md',
]

/**
 * Extract fenced ```yaml code blocks from a markdown string.
 * Returns array of { yaml, lineNumber } objects.
 */
function extractYamlBlocks(markdown: string): { yaml: string; lineNumber: number }[] {
  const blocks: { yaml: string; lineNumber: number }[] = []
  const regex = /```yaml\n([\s\S]*?)```/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(markdown)) !== null) {
    const lineNumber = markdown.slice(0, match.index).split('\n').length
    blocks.push({ yaml: match[1], lineNumber })
  }

  return blocks
}

/**
 * Returns true if the YAML block looks like a complete, runnable policy
 * (has a top-level `agents:` key AND at least one agent with a `description:`).
 * Skips structural overviews, placeholder snippets, and single-field examples.
 */
function isCompletePolicy(yaml: string): boolean {
  return /^agents:\s*$/m.test(yaml) && /description:\s*".+"/m.test(yaml) && /permissions:/m.test(yaml)
}

// Collect all testable blocks upfront
interface DocBlock {
  file: string
  lineNumber: number
  yaml: string
  tmpPath: string
}

const allBlocks: DocBlock[] = []
let blockIndex = 0

for (const file of DOC_FILES) {
  const filePath = join(docsDir, file)
  if (!existsSync(filePath)) continue

  const markdown = readFileSync(filePath, 'utf-8')
  const blocks = extractYamlBlocks(markdown)

  for (const block of blocks) {
    if (!isCompletePolicy(block.yaml)) continue

    allBlocks.push({
      file,
      lineNumber: block.lineNumber,
      yaml: block.yaml,
      tmpPath: join(tmpDir, `doc-block-${blockIndex++}.yaml`),
    })
  }
}

// Write temp files
mkdirSync(tmpDir, { recursive: true })
for (const block of allBlocks) {
  writeFileSync(block.tmpPath, block.yaml)
}

// Cleanup after all tests
afterAll(() => {
  for (const block of allBlocks) {
    if (existsSync(block.tmpPath)) unlinkSync(block.tmpPath)
  }
  if (existsSync(tmpDir)) {
    try { unlinkSync(tmpDir) } catch { /* dir may not be empty */ }
  }
})

describe('Doc ↔ Schema drift detection (CRS-49)', () => {
  it('found at least one complete policy block in docs', () => {
    expect(allBlocks.length).toBeGreaterThan(0)
  })

  for (const block of allBlocks) {
    it(`${block.file}:${block.lineNumber} — YAML validates against schema`, async () => {
      const { parsePolicy } = await import('../../src/policy/parser.js')

      let result: unknown
      try {
        result = await parsePolicy(block.tmpPath)
      } catch (err) {
        // Re-throw with context so the failure message shows which doc block broke
        throw new Error(
          `Schema validation failed for YAML block at ${block.file}:${block.lineNumber}\n` +
          `${(err as Error).message}\n\n` +
          `--- YAML content ---\n${block.yaml}`
        )
      }

      // Basic structural checks — the block parsed into a valid PolicyConfig
      expect(result).toBeDefined()
      expect(result).toHaveProperty('agents')
    })
  }
})
