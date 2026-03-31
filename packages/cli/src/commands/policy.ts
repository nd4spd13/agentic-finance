/**
 * guardian policy validate / show
 */

import { existsSync } from 'node:fs'
import { loadConfig } from '../config.js'
import { parsePolicy } from '@guardian-layer/core'

export async function policyValidateCommand(policyPath?: string): Promise<void> {
  const config = loadConfig()
  const target = policyPath ?? config.policy_path

  if (!existsSync(target)) {
    console.error(`Policy file not found: ${target}`)
    process.exit(1)
  }

  try {
    const policy = await parsePolicy(target)
    const agentCount = Object.keys(policy.agents ?? {}).length
    console.log(`✓ Policy is valid`)
    console.log(`  File:   ${target}`)
    console.log(`  Agents: ${agentCount} configured`)

    for (const [agentId, agentPolicy] of Object.entries(policy.agents ?? {})) {
      const perms = agentPolicy.permissions
      const flags: string[] = []

      if (perms?.transactions?.read !== false) flags.push('transactions')
      if (perms?.spending) flags.push('spending')
      if (perms?.escalation) flags.push('escalation')
      if (perms?.schedule) flags.push('schedule')

      console.log(`  · ${agentId}: ${flags.length > 0 ? flags.join(', ') : 'minimal'}`)
    }
  } catch (err) {
    console.error(`✗ Policy is invalid: ${err}`)
    process.exit(1)
  }
}

export async function policyShowCommand(policyPath?: string): Promise<void> {
  const config = loadConfig()
  const target = policyPath ?? config.policy_path

  if (!existsSync(target)) {
    console.error(`Policy file not found: ${target}`)
    process.exit(1)
  }

  try {
    const policy = await parsePolicy(target)
    console.log('\nParsed Policy:\n')
    console.log(JSON.stringify(policy, null, 2))
  } catch (err) {
    console.error(`Failed to parse policy: ${err}`)
    process.exit(1)
  }
}
