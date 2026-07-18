// Copyright 2024 CRSPY Inc.
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE in the
// repository root for the full license text.

import { Account } from '../types/data-provider.types.js'
import { AccountPermissions } from '../types/policy.types.js'

/**
 * Filters accounts by the policy's `visible` list. An entry in `visible`
 * matches an account if it equals the account's `id` OR its `type` — live
 * policies mix account IDs (e.g. "checking-001") with account types (e.g.
 * "checking"). An empty or undefined list means all accounts are visible.
 */
export function filterVisibleAccounts(accounts: Account[], visible: string[] | undefined): Account[] {
  if (!visible || visible.length === 0) {
    return accounts
  }
  return accounts.filter((account) => visible.includes(account.id) || visible.includes(account.type))
}

export interface RedactedAccount {
  account_id: string
  name?: string
  type: Account['type']
  subtype?: string
  institution?: string
  mask?: string
  current: number
  available?: number
  currency: string
  stale?: boolean
}

/**
 * Maps an internal Account to the shape exposed to agents, applying the
 * `AccountPermissions` field-level toggles.
 *
 * - `name` and `institution` default to visible (included unless explicitly
 *   set to `false`).
 * - `mask` (the last-4 masked account number) defaults to hidden — it is
 *   only included when `account_number` is explicitly `true`.
 */
export function redactAccount(account: Account, permissions: AccountPermissions | undefined): RedactedAccount {
  const redacted: RedactedAccount = {
    account_id: account.id,
    type: account.type,
    current: account.balance_current,
    currency: account.currency,
  }

  if (account.subtype !== undefined) {
    redacted.subtype = account.subtype
  }

  if (account.balance_available !== undefined) {
    redacted.available = account.balance_available
  }

  if (account.stale !== undefined) {
    redacted.stale = account.stale
  }

  if (permissions?.name !== false) {
    redacted.name = account.name
  }

  if (permissions?.institution !== false && account.institution !== undefined) {
    redacted.institution = account.institution
  }

  if (permissions?.account_number === true && account.mask !== undefined) {
    redacted.mask = account.mask
  }

  return redacted
}
