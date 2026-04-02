import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { parse as parseYaml } from 'yaml'
import { PolicyConfig } from '../types/index.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Dynamic import of ajv to handle ESM module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Ajv: any

const __dirname = dirname(fileURLToPath(import.meta.url))

async function getAjv() {
  if (!Ajv) {
    const ajvModule = await import('ajv')
    Ajv = ajvModule.default
  }
  return Ajv
}

export async function parsePolicy(filePath: string): Promise<PolicyConfig> {
  // If file doesn't exist, return deny-all default
  if (!existsSync(filePath)) {
    return { agents: {} }
  }

  // Read the file
  const content = await readFile(filePath, 'utf-8')

  // If file is empty, return deny-all default
  if (!content.trim()) {
    return { agents: {} }
  }

  // Parse YAML
  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch (error: unknown) {
    throw new Error(`Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Load schema
  const schemaPath = join(__dirname, 'policy.schema.json')
  const schemaContent = readFileSync(schemaPath, 'utf-8')
  const schema = JSON.parse(schemaContent)

  // Validate against schema
  const AjvClass = await getAjv()
  const ajv = new AjvClass()
  const validate = ajv.compile(schema)

  if (!validate(parsed)) {
    const errors = validate.errors?.map((err: { instancePath?: string; message?: string }) => `${err.instancePath || 'root'}: ${err.message}`).join('; ')
    throw new Error(`Policy validation failed: ${errors}`)
  }

  return parsed as PolicyConfig
}
