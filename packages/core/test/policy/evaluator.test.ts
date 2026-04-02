import { describe, it, expect } from 'vitest'
import { PolicyConfig } from '../../src/index.js'

describe('Policy Evaluator', () => {
  describe('Data Visibility Tests', () => {
    it('agent with visible: [checking] gets checking accounts, NOT savings', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'checking-only': {
            description: 'Checking only',
            permissions: {
              accounts: {
                visible: ['checking'],
                balance: true,
              },
            },
          },
        },
      }
      const result = await evaluate('checking-only', { type: 'data_request', resource: 'accounts' }, policy, {})
      expect(result.decision).toBe('allow')
    })

    it('agent with balance: false masks balance values', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'no-balance': {
            description: 'No balance view',
            permissions: {
              accounts: {
                visible: ['checking'],
                balance: false,
              },
            },
          },
        },
      }
      const result = await evaluate('no-balance', { type: 'data_request', resource: 'balance' }, policy, {})
      expect(result.decision).toBe('deny')
    })

    it('amount_visibility_cap redacts large amounts', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'capped': {
            description: 'Capped visibility',
            permissions: {
              transactions: {
                read: true,
                amount_visibility_cap: 500,
              },
            },
          },
        },
      }
      const result = await evaluate('capped', { type: 'transaction', amount: 750 }, policy, {})
      expect(result.constraints_applied).toContainEqual(expect.objectContaining({
        field: 'amount_visibility_cap',
        source: 'ap2',
      }))
    })

    it('lookback_days excludes old transactions', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'recent': {
            description: 'Recent only',
            permissions: {
              transactions: {
                read: true,
                lookback_days: 30,
              },
            },
          },
        },
      }
      const result = await evaluate('recent', { type: 'transaction', age_days: 45 }, policy, {})
      expect(result.decision).toBe('deny')
    })

    it('unknown agent denies with clear reason', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = { agents: {} }
      const result = await evaluate('unknown-agent', { type: 'any_request' }, policy, {})
      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('unknown')
    })

    it('account type not in visible is denied, not absent', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'checking-only': {
            description: 'Checking only',
            permissions: {
              accounts: {
                visible: ['checking'],
                balance: true,
              },
            },
          },
        },
      }
      const result = await evaluate('checking-only', { type: 'data_request', resource: 'accounts', account_type: 'savings' }, policy, {})
      expect(result.decision).toBe('deny')
    })
  })

  describe('Spending Authorization Tests (AP2-derived)', () => {
    it('$99 with max_per_transaction:100 allows', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'spender': {
            description: 'Spending limits',
            permissions: {
              spending: {
                max_per_transaction: 100,
              },
            },
          },
        },
      }
      const result = await evaluate('spender', { type: 'transaction', amount: 99 }, policy, {})
      expect(result.decision).toBe('allow')
      expect(result.constraints_applied).toContainEqual(
        expect.objectContaining({ source: 'ap2' })
      )
    })

    it('$101 with max_per_transaction:100 denies', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'spender': {
            description: 'Spending limits',
            permissions: {
              spending: {
                max_per_transaction: 100,
              },
            },
          },
        },
      }
      const result = await evaluate('spender', { type: 'transaction', amount: 101 }, policy, {})
      expect(result.decision).toBe('deny')
    })

    it('$100 exactly with max_per_transaction:100 allows (inclusive boundary)', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'spender': {
            description: 'Spending limits',
            permissions: {
              spending: {
                max_per_transaction: 100,
              },
            },
          },
        },
      }
      const result = await evaluate('spender', { type: 'transaction', amount: 100 }, policy, {})
      expect(result.decision).toBe('allow')
    })

    it('daily spend $199 + new $50 with max_daily:200 denies', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'daily-limited': {
            description: 'Daily limit',
            permissions: {
              spending: {
                max_daily: 200,
              },
            },
          },
        },
      }
      const context = { today_spend: 199 }
      const result = await evaluate('daily-limited', { type: 'transaction', amount: 50 }, policy, context)
      expect(result.decision).toBe('deny')
    })

    it('merchant block logic prevents blocked merchants', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'merchant-limited': {
            description: 'Merchant restrictions',
            permissions: {
              spending: {
                merchants: {
                  block: ['Casino'],
                },
              },
            },
          },
        },
      }
      const result = await evaluate('merchant-limited', { type: 'transaction', merchant: 'Casino' }, policy, {})
      expect(result.decision).toBe('deny')
    })

    it('merchant "amazon.com" with merchants.allow: ["amazon.com"] allows', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'allow-merchant': {
            description: 'Merchant allow list',
            permissions: {
              spending: {
                merchants: {
                  allow: ['amazon.com'],
                },
              },
            },
          },
        },
      }
      const result = await evaluate('allow-merchant', { type: 'transaction', merchant: 'amazon.com' }, policy, {})
      expect(result.decision).toBe('allow')
    })

    it('merchant "shady.com" with merchants.allow: ["amazon.com"] denies', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'allow-merchant': {
            description: 'Merchant allow list',
            permissions: {
              spending: {
                merchants: {
                  allow: ['amazon.com'],
                },
              },
            },
          },
        },
      }
      const result = await evaluate('allow-merchant', { type: 'transaction', merchant: 'shady.com' }, policy, {})
      expect(result.decision).toBe('deny')
    })

    it('both merchants.allow AND merchants.block set throws validation error', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'bad-config': {
            description: 'Invalid config',
            permissions: {
              spending: {
                merchants: {
                  allow: ['amazon.com'],
                  block: ['shady.com'],
                },
              },
            },
          },
        },
      }
      const result = await evaluate('bad-config', { type: 'transaction', merchant: 'amazon.com' }, policy, {})
      expect(result.decision).toBe('deny')
      expect(result.reason).toMatch(/allow.*block|both|conflict/i)
    })

    it('category block logic prevents blocked categories', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'cat-limited': {
            description: 'Category restrictions',
            permissions: {
              spending: {
                categories: {
                  block: ['gambling'],
                },
              },
            },
          },
        },
      }
      const result = await evaluate('cat-limited', { type: 'transaction', category: 'gambling' }, policy, {})
      expect(result.decision).toBe('deny')
    })
  })

  describe('Escalation Trigger Tests (Novel-derived)', () => {
    it('$51 with amount_exceeds:50 escalates', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'escalating': {
            description: 'Escalation on amount',
            permissions: {
              escalation: {
                triggers: [{ amount_exceeds: 50 }],
                channel: 'cli',
                timeout: '5m',
                default_on_timeout: 'deny',
              },
            },
          },
        },
      }
      const result = await evaluate('escalating', { type: 'transaction', amount: 51 }, policy, {})
      expect(result.decision).toBe('escalate')
      expect(result.constraints_applied).toContainEqual(
        expect.objectContaining({ source: 'escalation' })
      )
    })

    it('$50 with amount_exceeds:50 does NOT escalate (boundary)', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'escalating': {
            description: 'Escalation on amount',
            permissions: {
              escalation: {
                triggers: [{ amount_exceeds: 50 }],
                channel: 'cli',
                timeout: '5m',
                default_on_timeout: 'deny',
              },
            },
          },
        },
      }
      const result = await evaluate('escalating', { type: 'transaction', amount: 50 }, policy, {})
      expect(result.decision).toBe('allow')
    })

    it('new merchant with new_merchant:true escalates', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'escalating': {
            description: 'Escalation on new merchant',
            permissions: {
              escalation: {
                triggers: [{ new_merchant: true }],
                channel: 'cli',
                timeout: '5m',
                default_on_timeout: 'deny',
              },
            },
          },
        },
      }
      const context = { known_merchants: [] }
      const result = await evaluate('escalating', { type: 'transaction', merchant: 'New Vendor' }, policy, context)
      expect(result.decision).toBe('escalate')
    })

    it('repeat merchant does NOT escalate', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'escalating': {
            description: 'Escalation on new merchant',
            permissions: {
              escalation: {
                triggers: [{ new_merchant: true }],
                channel: 'cli',
                timeout: '5m',
                default_on_timeout: 'deny',
              },
            },
          },
        },
      }
      const context = { known_merchants: ['Amazon'] }
      const result = await evaluate('escalating', { type: 'transaction', merchant: 'Amazon' }, policy, context)
      expect(result.decision).toBe('allow')
    })

    it('category "electronics" with category trigger escalates', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'cat-escalate': {
            description: 'Category escalation',
            permissions: {
              escalation: {
                triggers: [{ category: ['electronics'] }],
                channel: 'cli',
                timeout: '5m',
                default_on_timeout: 'deny',
              },
            },
          },
        },
      }
      const result = await evaluate('cat-escalate', { type: 'transaction', category: 'electronics' }, policy, {})
      expect(result.decision).toBe('escalate')
    })

    it('multiple triggers use OR logic', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'multi-escalate': {
            description: 'Multiple triggers',
            permissions: {
              escalation: {
                triggers: [
                  { amount_exceeds: 1000 },
                  { category: ['travel'] },
                ],
                channel: 'cli',
                timeout: '5m',
                default_on_timeout: 'deny',
              },
            },
          },
        },
      }
      const result = await evaluate('multi-escalate', { type: 'transaction', amount: 100, category: 'travel' }, policy, {})
      expect(result.decision).toBe('escalate')
    })

    it('denied action never escalated', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'denied': {
            description: 'No permissions',
            permissions: {
              escalation: {
                triggers: [{ amount_exceeds: 10 }],
                channel: 'cli',
                timeout: '5m',
                default_on_timeout: 'deny',
              },
            },
          },
        },
      }
      const result = await evaluate('denied', { type: 'transaction', amount: 1000, category: 'blocked' }, policy, {})
      expect(result.decision).toBe('deny')
    })
  })

  describe('Temporal Rules (Nekuda-derived)', () => {
    it('14:00 within active_hours "09:00-22:00" allows', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'scheduled': {
            description: 'Scheduled agent',
            permissions: {
              schedule: {
                active_hours: '09:00-22:00',
              },
            },
          },
        },
      }
      const context = { current_time: '14:00' }
      const result = await evaluate('scheduled', { type: 'transaction' }, policy, context)
      expect(result.decision).toBe('allow')
      expect(result.constraints_applied).toContainEqual(
        expect.objectContaining({ source: 'schedule' })
      )
    })

    it('23:00 outside active_hours denies', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'scheduled': {
            description: 'Scheduled agent',
            permissions: {
              schedule: {
                active_hours: '09:00-22:00',
                behavior_outside_schedule: 'deny',
              },
            },
          },
        },
      }
      const context = { current_time: '23:00' }
      const result = await evaluate('scheduled', { type: 'transaction' }, policy, context)
      expect(result.decision).toBe('deny')
    })

    it('Saturday with active_days mon-fri denies', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'weekday': {
            description: 'Weekday only',
            permissions: {
              schedule: {
                active_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
              },
            },
          },
        },
      }
      const context = { current_day: 'saturday' }
      const result = await evaluate('weekday', { type: 'transaction' }, policy, context)
      expect(result.decision).toBe('deny')
    })

    it('blackout date denies', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'holidays': {
            description: 'Holiday-aware',
            permissions: {
              schedule: {
                blackout_dates: ['2026-12-25'],
              },
            },
          },
        },
      }
      const context = { current_date: '2026-12-25' }
      const result = await evaluate('holidays', { type: 'transaction' }, policy, context)
      expect(result.decision).toBe('deny')
    })

    it('no schedule allows always', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'always-on': {
            description: 'Always active',
            permissions: {
              accounts: {
                visible: ['checking'],
              },
            },
          },
        },
      }
      const result = await evaluate('always-on', { type: 'transaction' }, policy, {})
      expect(result.decision).toBe('allow')
    })

    it('behavior_outside_schedule escalate triggers escalation', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'escalating': {
            description: 'Escalate on off-hours',
            permissions: {
              schedule: {
                active_hours: '09:00-22:00',
                behavior_outside_schedule: 'escalate',
              },
            },
          },
        },
      }
      const context = { current_time: '23:30' }
      const result = await evaluate('escalating', { type: 'transaction' }, policy, context)
      expect(result.decision).toBe('escalate')
    })

    it('midnight-crossing "22:00-06:00" works correctly', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'night': {
            description: 'Night shift',
            permissions: {
              schedule: {
                active_hours: '22:00-06:00',
              },
            },
          },
        },
      }
      const context = { current_time: '23:00' }
      const result = await evaluate('night', { type: 'transaction' }, policy, context)
      expect(result.decision).toBe('allow')
    })
  })

  describe('Cross-Agent Coordination', () => {
    it('combined spend $900 + $200 with global max:1000 denies', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'agent1': {
            description: 'Agent 1',
            permissions: { accounts: { visible: [] } },
          },
        },
        global: {
          max_total_daily_spend: 1000,
        },
      }
      const context = { total_daily_spend: 900 }
      const result = await evaluate('agent1', { type: 'transaction', amount: 200 }, policy, context)
      expect(result.decision).toBe('deny')
    })

    it('global blocked category overrides agent allow', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'agent': {
            description: 'Agent',
            permissions: {
              spending: {
                categories: {
                  allow: ['gambling'],
                },
              },
            },
          },
        },
        global: {
          global_blocked_categories: ['gambling'],
        },
      }
      const result = await evaluate('agent', { type: 'transaction', category: 'gambling' }, policy, {})
      expect(result.decision).toBe('deny')
    })

    it('max_concurrent_agents enforcement', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'agent1': {
            description: 'Agent 1',
            permissions: { accounts: { visible: [] } },
          },
        },
        global: {
          max_concurrent_agents: 2,
        },
      }
      const context = { concurrent_agents: 3 }
      const result = await evaluate('agent1', { type: 'transaction' }, policy, context)
      expect(result.decision).toBe('deny')
    })

    it('global rules checked before agent rules', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'agent': {
            description: 'Agent',
            permissions: {
              spending: {
                merchants: {
                  block: ['Casino'],
                },
              },
            },
          },
        },
        global: {
          global_blocked_merchants: ['Casino'],
        },
      }
      const result = await evaluate('agent', { type: 'transaction', merchant: 'Casino' }, policy, {})
      expect(result.decision).toBe('deny')
      expect(result.checks_performed).toContain('global_rules')
    })
  })

  describe('Evaluation Flow', () => {
    it('returns full PolicyEvaluation with all fields', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'test': {
            description: 'Test agent',
            permissions: {
              accounts: {
                visible: ['checking'],
              },
            },
          },
        },
      }
      const result = await evaluate('test', { type: 'transaction' }, policy, {})
      expect(result.decision).toBeDefined()
      expect(result.reason).toBeDefined()
      expect(result.policy_rule).toBeDefined()
      expect(result.checks_performed).toBeInstanceOf(Array)
      expect(result.constraints_applied).toBeInstanceOf(Array)
    })

    it('checks_performed lists evaluated rules', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'test': {
            description: 'Test',
            permissions: {
              spending: { max_daily: 1000 },
              escalation: {
                triggers: [{ amount_exceeds: 500 }],
                channel: 'cli',
                timeout: '5m',
                default_on_timeout: 'deny',
              },
            },
          },
        },
      }
      const result = await evaluate('test', { type: 'transaction', amount: 300 }, policy, {})
      expect(result.checks_performed.length).toBeGreaterThan(0)
    })

    it('constraints_applied populated with source standard', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'test': {
            description: 'Test',
            permissions: {
              spending: {
                max_per_transaction: 500,
              },
              schedule: {
                active_hours: '09:00-18:00',
              },
            },
          },
        },
      }
      const context = { current_time: '12:00' }
      const result = await evaluate('test', { type: 'transaction', amount: 100 }, policy, context)
      expect(result.constraints_applied.length).toBeGreaterThan(0)
      result.constraints_applied.forEach(constraint => {
        expect(['ap2', 'schedule', 'escalation', 'mcp-oauth', 'ack']).toContain(constraint.source)
      })
    })

    it('standards_ref populated', async () => {
      const { evaluate } = await import('../../src/policy/evaluator.js')
      const policy: PolicyConfig = {
        agents: {
          'test': {
            description: 'Test',
            permissions: {
              spending: { max_daily: 1000 },
            },
          },
        },
      }
      const result = await evaluate('test', { type: 'transaction' }, policy, {})
      if (result.constraints_applied.length > 0) {
        expect(result.standards_ref).toBeDefined()
      }
    })
  })
})
