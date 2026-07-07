import { describe, it, expectTypeOf } from 'vitest'
import type { FinancialDataProvider } from '@clad/core'
import type { PlaidAdapter } from '../../src/adapter.js'
import type { StoredItemMeta } from '../../src/token-store.types.js'

describe('PlaidAdapter typing', () => {
  it('PlaidAdapter is assignable to FinancialDataProvider', () => {
    expectTypeOf<PlaidAdapter>().toMatchTypeOf<FinancialDataProvider>()
  })

  it('StoredItemMeta never carries token material', () => {
    expectTypeOf<StoredItemMeta>().not.toHaveProperty('accessToken')
    expectTypeOf<StoredItemMeta>().not.toHaveProperty('token')
  })
})
