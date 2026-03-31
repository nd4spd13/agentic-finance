/**
 * Guardian Layer CLI — Config manager
 * Reads/writes ~/.guardian-layer/config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface GuardianConfig {
  policy_path: string
  audit_db: string
  approval_db: string
  server_pid_file: string
}

export function getConfigDir(): string {
  return process.env.GUARDIAN_CONFIG_DIR ?? join(homedir(), '.guardian-layer')
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export function defaultConfig(): GuardianConfig {
  const dir = getConfigDir()
  return {
    policy_path: join(dir, 'policy.yaml'),
    audit_db: join(dir, 'audit.sqlite'),
    approval_db: join(dir, 'approvals.sqlite'),
    server_pid_file: join(dir, 'server.pid'),
  }
}

export function loadConfig(): GuardianConfig {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    return defaultConfig()
  }
  const raw = readFileSync(configPath, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<GuardianConfig>
  const defaults = defaultConfig()
  return {
    policy_path: parsed.policy_path
      ? resolve(parsed.policy_path.replace('~', homedir()))
      : defaults.policy_path,
    audit_db: parsed.audit_db
      ? resolve(parsed.audit_db.replace('~', homedir()))
      : defaults.audit_db,
    approval_db: parsed.approval_db
      ? resolve(parsed.approval_db.replace('~', homedir()))
      : defaults.approval_db,
    server_pid_file: parsed.server_pid_file
      ? resolve(parsed.server_pid_file.replace('~', homedir()))
      : defaults.server_pid_file,
  }
}

export function saveConfig(config: GuardianConfig): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function ensureConfigDir(): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}
