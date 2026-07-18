import { describe, it, expect } from 'vitest'
import { filterVisibleAccounts, redactAccount } from '../../src/policy/account-visibility.js'
import { Account } from '../../src/types/data-provider.types.js'

const checking: Account = {
  id: 'checking-001',
  name: 'Primary Checking',
  type: 'checking',
  institution: 'Bank A',
  mask: '1234',
  balance_current: 1000,
  balance_available: 950,
  currency: 'USD',
}

const savings: Account = {
  id: 'savings-001',
  name: 'Emergency Savings',
  type: 'savings',
  institution: 'Bank B',
  mask: '5678',
  balance_current: 5000,
  currency: 'USD',
}

const credit: Account = {
  id: 'credit-001',
  name: 'Rewards Card',
  type: 'credit',
  balance_current: -200,
  currency: 'USD',
}

describe('filterVisibleAccounts', () => {
  it('empty list returns all accounts', () => {
    const result = filterVisibleAccounts([checking, savings], [])
    expect(result).toEqual([checking, savings])
  })

  it('undefined list returns all accounts', () => {
    const result = filterVisibleAccounts([checking, savings], undefined)
    expect(result).toEqual([checking, savings])
  })

  it('matches by account id', () => {
    const result = filterVisibleAccounts([checking, savings], ['checking-001'])
    expect(result).toEqual([checking])
  })

  it('matches by account type', () => {
    const result = filterVisibleAccounts([checking, savings], ['savings'])
    expect(result).toEqual([savings])
  })

  it('matches a mixed list of ids and types', () => {
    const result = filterVisibleAccounts([checking, savings, credit], ['checking-001', 'credit'])
    expect(result).toEqual([checking, credit])
  })

  it('returns empty array when nothing matches', () => {
    const result = filterVisibleAccounts([checking, savings], ['loan-999'])
    expect(result).toEqual([])
  })
})

describe('redactAccount', () => {
  it('default permissions include name and institution, omit mask', () => {
    const result = redactAccount(checking, { visible: [] })
    expect(result).toEqual({
      account_id: 'checking-001',
      name: 'Primary Checking',
      type: 'checking',
      institution: 'Bank A',
      current: 1000,
      available: 950,
      currency: 'USD',
    })
    expect(result).not.toHaveProperty('mask')
  })

  it('name: false hides the name field', () => {
    const result = redactAccount(checking, { visible: [], name: false })
    expect(result).not.toHaveProperty('name')
    expect(result.institution).toBe('Bank A')
  })

  it('institution: false hides the institution field', () => {
    const result = redactAccount(checking, { visible: [], institution: false })
    expect(result).not.toHaveProperty('institution')
    expect(result.name).toBe('Primary Checking')
  })

  it('account_number: true reveals the mask', () => {
    const result = redactAccount(checking, { visible: [], account_number: true })
    expect(result.mask).toBe('1234')
  })

  it('account_number omitted or false hides the mask', () => {
    const resultDefault = redactAccount(checking, { visible: [] })
    const resultFalse = redactAccount(checking, { visible: [], account_number: false })
    expect(resultDefault).not.toHaveProperty('mask')
    expect(resultFalse).not.toHaveProperty('mask')
  })

  it('undefined permissions object behaves as defaults', () => {
    const result = redactAccount(checking, undefined)
    expect(result.name).toBe('Primary Checking')
    expect(result.institution).toBe('Bank A')
    expect(result).not.toHaveProperty('mask')
  })

  it('account without a mask + account_number: true still has no mask key', () => {
    const result = redactAccount(credit, { visible: [], account_number: true })
    expect(result).not.toHaveProperty('mask')
  })

  it('account without institution omits the institution key even when visible', () => {
    const result = redactAccount(credit, { visible: [] })
    expect(result).not.toHaveProperty('institution')
  })

  it('maps balance_current/balance_available to current/available', () => {
    const result = redactAccount(checking, { visible: [] })
    expect(result.current).toBe(1000)
    expect(result.available).toBe(950)
  })
})
