import { describe, it, expect } from 'vitest'
import { DummyDataProvider, type PolicyConfig } from '@clad/core'
import * as getBalances from '../src/tools/clad_get_balances.js'
import * as getTransactions from '../src/tools/clad_get_transactions.js'
import * as safeToSpend from '../src/tools/clad_safe_to_spend.js'
import * as requestAction from '../src/tools/clad_request_action.js'
import * as auditLog from '../src/tools/clad_audit_log.js'
import { AuditLogger, ApprovalQueue } from '@clad/core'

describe('MCP Tool Handlers', () => {
  const provider = new DummyDataProvider()

  describe('clad_get_balances', () => {
    it('returns balances for allowed agent', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {
              accounts: {
                visible: ['checking', 'savings'],
                balance: true,
              },
            },
          },
        },
      }
      const result = await getBalances.handler(
        { user_id: 'user123' },
        { agentId: 'test-agent', policy, provider }
      )
      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('account_id')
    })

    it('denies unknown agent', async () => {
      const policy: PolicyConfig = { agents: {} }
      const result = await getBalances.handler(
        { user_id: 'user123' },
        { agentId: 'unknown', policy, provider }
      )
      expect(result.content[0].text).toContain('Denied')
    })

    it('filters by account type', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {
              accounts: {
                visible: ['checking', 'savings'],
                balance: true,
              },
            },
          },
        },
      }
      const result = await getBalances.handler(
        { user_id: 'user123', account_type: 'checking' },
        { agentId: 'test-agent', policy, provider }
      )
      expect(result.content[0].type).toBe('text')
      const parsed = JSON.parse(result.content[0].text)
      expect(Array.isArray(parsed)).toBe(true)
    })
  })

  describe('clad_get_transactions', () => {
    it('returns transactions for allowed agent', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {
              transactions: {
                read: true,
              },
            },
          },
        },
      }
      const result = await getTransactions.handler(
        { user_id: 'user123', account_id: 'acc_checking_001' },
        { agentId: 'test-agent', policy, provider }
      )
      expect(result.content[0].type).toBe('text')
      const parsed = JSON.parse(result.content[0].text)
      expect(Array.isArray(parsed)).toBe(true)
    })

    it('denies unknown agent', async () => {
      const policy: PolicyConfig = { agents: {} }
      const result = await getTransactions.handler(
        { user_id: 'user123', account_id: 'acc_checking_001' },
        { agentId: 'unknown', policy, provider }
      )
      expect(result.content[0].text).toContain('Denied')
    })
  })

  describe('clad_safe_to_spend', () => {
    it('calculates safe to spend', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {
              accounts: {
                visible: ['checking'],
                balance: true,
              },
            },
          },
        },
      }
      const result = await safeToSpend.handler(
        { user_id: 'user123', account_id: 'acc_checking_001' },
        { agentId: 'test-agent', policy, provider }
      )
      expect(result.content[0].type).toBe('text')
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed).toHaveProperty('safe_to_spend')
      expect(typeof parsed.safe_to_spend).toBe('number')
    })
  })

  describe('clad_request_action', () => {
    it('allows spending request within limits', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {
              spending: {
                max_per_transaction: 1000,
              },
            },
          },
        },
      }
      const result = await requestAction.handler(
        { amount: 50, merchant: 'Starbucks', category: 'food' },
        { agentId: 'test-agent', policy, provider, approvalQueue: new ApprovalQueue(':memory:') }
      )
      expect(result.content[0].type).toBe('text')
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.decision).toBe('allow')
    })

    it('denies spending request exceeding limits', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {
              spending: {
                max_per_transaction: 100,
              },
            },
          },
        },
      }
      const result = await requestAction.handler(
        { amount: 500, merchant: 'Starbucks', category: 'food' },
        { agentId: 'test-agent', policy, provider, approvalQueue: new ApprovalQueue(':memory:') }
      )
      expect(result.content[0].type).toBe('text')
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.decision).toBe('deny')
    })

    it('escalates on trigger match', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {
              spending: {
                max_per_transaction: 1000,
              },
              escalation: {
                triggers: [
                  { amount_exceeds: 100 },
                ],
                channel: 'cli',
                timeout: '15m',
                default_on_timeout: 'deny',
              },
            },
          },
        },
      }
      const result = await requestAction.handler(
        { amount: 150, merchant: 'Starbucks', category: 'food' },
        { agentId: 'test-agent', policy, provider, approvalQueue: new ApprovalQueue(':memory:') }
      )
      expect(result.content[0].type).toBe('text')
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.decision).toBe('escalate')
      expect(parsed).toHaveProperty('approval_id')
    })
  })

  describe('clad_audit_log', () => {
    it('returns audit records', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {},
          },
        },
      }
      const auditLogger = new AuditLogger(':memory:')
      // Log some test records
      auditLogger.logRequest('test-agent', 'clad_get_balances', 'allow', 'test')
      auditLogger.logRequest('test-agent', 'clad_request_action', 'deny', 'test')

      const result = await auditLog.handler(
        {},
        { agentId: 'test-agent', policy, auditLogger }
      )
      expect(result.content[0].type).toBe('text')
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.count).toBe(2)
      expect(parsed.chain_valid).toBe(true)
    })

    it('filters by agent_id', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {},
          },
        },
      }
      const auditLogger = new AuditLogger(':memory:')
      auditLogger.logRequest('test-agent', 'clad_get_balances', 'allow', 'test')
      auditLogger.logRequest('other-agent', 'clad_request_action', 'deny', 'test')

      const result = await auditLog.handler(
        { agent_id: 'test-agent' },
        { agentId: 'test-agent', policy, auditLogger }
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.count).toBe(1)
    })

    it('verifies audit chain integrity', async () => {
      const policy: PolicyConfig = {
        agents: {
          'test-agent': {
            description: 'Test agent',
            permissions: {},
          },
        },
      }
      const auditLogger = new AuditLogger(':memory:')
      auditLogger.logRequest('test-agent', 'tool1', 'allow', 'msg1')
      auditLogger.logRequest('test-agent', 'tool2', 'deny', 'msg2')

      const result = await auditLog.handler(
        {},
        { agentId: 'test-agent', policy, auditLogger }
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.chain_valid).toBe(true)
    })
  })
})
