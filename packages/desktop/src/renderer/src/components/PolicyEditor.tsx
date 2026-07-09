import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import type {
  PolicyAccountPermissions,
  PolicyAgent,
  PolicyAgentPermissions,
  PolicyAuditConfig,
  PolicyDoc,
  PolicyEscalationConfig,
  PolicyEscalationTrigger,
  PolicyGlobalRules,
  PolicyScheduleConfig,
  PolicySpendingPermissions,
  PolicyTransactionPermissions,
} from '../../../shared/ipc.js'
import * as s from '../styles.js'

/**
 * D2.4 policy editor: a desktop-renderer port of `packages/cli/static/
 * index.html`'s React SPA (which ran standalone in a browser tab against
 * `clad ui`'s Express routes — CDN React/Tailwind/js-yaml, no build step).
 * Same feature set (global rules, per-agent permission sections, an add/
 * delete agent flow, a live YAML preview, explicit Save with schema-
 * validation errors surfaced inline) reimplemented as typed TSX against
 * `PolicyDoc` (shared/ipc.ts's standalone mirror of `@clad/core`'s
 * `PolicyConfig`), using this app's existing plain-inline-style system
 * (`styles.ts`) instead of Tailwind/CDN scripts — those aren't usable here
 * at all (no external network access in the renderer; see the desktop
 * security checklist).
 *
 * IPC replaces the HTTP API 1:1: `getPolicy()` for `GET /api/policy`,
 * `setPolicy(doc)` for `PUT /api/policy` — see `main/lib/policy-data.ts` for
 * the main-process side, which validates via `parsePolicy` and only writes
 * to disk once that succeeds, exactly like `ui.ts`'s Express handler did.
 *
 * Not rate-limited / not cached like the D2.3 dashboard: this reads a local
 * YAML file, not a third-party API with a quota, so `getPolicy()` re-reads
 * fresh from disk on every mount/retry — there is no "stale data" concern
 * here the way there is for a Plaid/SimpleFIN balance fetch.
 */

const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'loan', 'investment'] as const
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
] as const

const TRIGGER_TYPES = [
  { value: 'amount_exceeds', label: 'Amount exceeds', inputType: 'number' },
  { value: 'new_merchant', label: 'New merchant', inputType: 'boolean' },
  { value: 'new_category', label: 'New category', inputType: 'boolean' },
  { value: 'category', label: 'Category list', inputType: 'tags' },
  { value: 'merchant', label: 'Merchant list', inputType: 'tags' },
  { value: 'daily_spend_exceeds_pct', label: 'Daily spend % exceeds', inputType: 'number' },
] as const

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Recursively drops any nested plain object left with zero keys (never touches arrays) — same "don't leave `spending: {}` lying around" cleanup `ui.ts`'s SPA did client-side before every save. */
function pruneEmptyObjects(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      pruneEmptyObjects(val as Record<string, unknown>)
      if (Object.keys(val as Record<string, unknown>).length === 0) delete obj[key]
    }
  }
}

// ---- small field helpers ----------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div style={s.fieldRow}>
      <div style={s.fieldLabel}>{label}</div>
      <div style={s.fieldControl}>{children}</div>
    </div>
  )
}

function CheckboxField({
  checked,
  onChange,
  label,
}: {
  checked: boolean | undefined
  onChange: (checked: boolean) => void
  label: string
}): JSX.Element {
  return (
    <label style={s.checkboxRow}>
      <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function NumberField({
  value,
  onChange,
  placeholder,
}: {
  value: number | undefined
  onChange: (value: number | undefined) => void
  placeholder?: string
}): JSX.Element {
  return (
    <input
      type="number"
      style={{ ...s.input, marginBottom: 0 }}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value
        onChange(raw === '' ? undefined : Number(raw))
      }}
    />
  )
}

function TextField({
  value,
  onChange,
  placeholder,
}: {
  value: string | undefined
  onChange: (value: string | undefined) => void
  placeholder?: string
}): JSX.Element {
  return (
    <input
      type="text"
      style={{ ...s.input, marginBottom: 0 }}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value || undefined)}
    />
  )
}

function TagInput({
  values,
  onChange,
  placeholder = 'Add…',
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}): JSX.Element {
  const [text, setText] = useState('')

  function add(): void {
    const v = text.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setText('')
  }

  return (
    <div style={s.tagInputWrap}>
      {values.map((v) => (
        <span key={v} style={s.tag}>
          {v}
          <button type="button" style={s.tagRemove} aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <input
        style={s.tagInputField}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
      />
    </div>
  )
}

// ---- escalation trigger row --------------------------------------------------

function triggerKey(trigger: PolicyEscalationTrigger): string {
  return Object.keys(trigger)[0]
}

function triggerValue(trigger: PolicyEscalationTrigger): unknown {
  return Object.values(trigger as unknown as Record<string, unknown>)[0]
}

function TriggerRow({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: PolicyEscalationTrigger
  onChange: (next: PolicyEscalationTrigger) => void
  onRemove: () => void
}): JSX.Element {
  const key = triggerKey(trigger)
  const value = triggerValue(trigger)
  const def = TRIGGER_TYPES.find((t) => t.value === key) ?? TRIGGER_TYPES[0]

  function changeType(newKey: string): void {
    const newDef = TRIGGER_TYPES.find((t) => t.value === newKey)
    const defaultValue = newDef?.inputType === 'boolean' ? true : newDef?.inputType === 'tags' ? [] : 0
    onChange({ [newKey]: defaultValue } as PolicyEscalationTrigger)
  }

  return (
    <div style={s.triggerRow}>
      <select style={{ ...s.select, marginBottom: 0, width: 'auto' }} value={key} onChange={(e) => changeType(e.target.value)}>
        {TRIGGER_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      {def.inputType === 'number' && (
        <input
          type="number"
          style={{ ...s.input, marginBottom: 0, width: 100 }}
          value={typeof value === 'number' ? value : 0}
          onChange={(e) => onChange({ [key]: Number(e.target.value) } as PolicyEscalationTrigger)}
        />
      )}
      {def.inputType === 'boolean' && (
        <CheckboxField
          checked={Boolean(value)}
          onChange={(v) => onChange({ [key]: v } as PolicyEscalationTrigger)}
          label="enabled"
        />
      )}
      {def.inputType === 'tags' && (
        <div style={{ flex: 1 }}>
          <TagInput
            values={Array.isArray(value) ? (value as string[]) : []}
            onChange={(v) => onChange({ [key]: v } as PolicyEscalationTrigger)}
          />
        </div>
      )}
      <button type="button" style={s.tagRemove} aria-label="Remove trigger" onClick={onRemove}>
        ×
      </button>
    </div>
  )
}

// ---- global rules editor -----------------------------------------------------

function GlobalEditor({
  global,
  onChange,
}: {
  global: PolicyGlobalRules | undefined
  onChange: (next: PolicyGlobalRules | undefined) => void
}): JSX.Element {
  const g = global ?? {}

  function update(patch: Partial<PolicyGlobalRules>): void {
    const next: Record<string, unknown> = deepClone({ ...g, ...patch })
    pruneEmptyObjects(next)
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key]
    }
    onChange(Object.keys(next).length > 0 ? (next as PolicyGlobalRules) : undefined)
  }

  return (
    <div style={s.card}>
      <p style={s.sectionTitle}>Org-wide limits</p>
      <Field label="Max daily spend ($)">
        <NumberField value={g.max_total_daily_spend} onChange={(v) => update({ max_total_daily_spend: v })} />
      </Field>
      <Field label="Max weekly spend ($)">
        <NumberField value={g.max_total_weekly_spend} onChange={(v) => update({ max_total_weekly_spend: v })} />
      </Field>
      <Field label="Max monthly spend ($)">
        <NumberField value={g.max_total_monthly_spend} onChange={(v) => update({ max_total_monthly_spend: v })} />
      </Field>
      <Field label="Max concurrent agents">
        <NumberField value={g.max_concurrent_agents} onChange={(v) => update({ max_concurrent_agents: v })} />
      </Field>
      <Field label="Max pending escalations">
        <NumberField value={g.max_pending_escalations} onChange={(v) => update({ max_pending_escalations: v })} />
      </Field>
      <Field label="Blocked categories">
        <TagInput
          values={g.global_blocked_categories ?? []}
          onChange={(v) => update({ global_blocked_categories: v.length ? v : undefined })}
        />
      </Field>
      <Field label="Blocked merchants">
        <TagInput
          values={g.global_blocked_merchants ?? []}
          onChange={(v) => update({ global_blocked_merchants: v.length ? v : undefined })}
        />
      </Field>
    </div>
  )
}

// ---- agent editor -------------------------------------------------------------

function AgentEditor({
  agent,
  onChange,
}: {
  agent: PolicyAgent
  onChange: (next: PolicyAgent) => void
}): JSX.Element {
  const permissions = agent.permissions ?? {}
  const acc = permissions.accounts
  const tx = permissions.transactions
  const sp = permissions.spending ?? {}
  const esc = permissions.escalation
  const sched = permissions.schedule ?? {}
  const audit = permissions.audit ?? {}

  function commit(next: PolicyAgentPermissions): void {
    const pruned = deepClone(next) as Record<string, unknown>
    pruneEmptyObjects(pruned)
    onChange({ ...agent, permissions: pruned as PolicyAgentPermissions })
  }

  // `visible`/`read` are the one required field in each of these two
  // sections' schema — defaulting them here whenever ANY field in the
  // section is touched (not just the field itself) closes a gap the
  // original CLI SPA had: toggling e.g. "Balance visible" first, before
  // ever touching "Visible account types", produced an `accounts` object
  // missing its required `visible` array, which only surfaced as a schema
  // error at Save time. Defaulting to an empty (unrestricted) array/false
  // here keeps every intermediate state schema-valid.
  function updateAccounts(patch: Partial<PolicyAccountPermissions>): void {
    const current: PolicyAccountPermissions = acc ?? { visible: [] }
    const next: PolicyAccountPermissions = { ...current, ...patch }
    commit({ ...permissions, accounts: next })
  }

  function updateTransactions(patch: Partial<PolicyTransactionPermissions>): void {
    const current: PolicyTransactionPermissions = tx ?? { read: false }
    const next: PolicyTransactionPermissions = { ...current, ...patch }
    commit({ ...permissions, transactions: next })
  }

  function updateSpending(patch: Partial<PolicySpendingPermissions>): void {
    const next: PolicySpendingPermissions = { ...sp, ...patch }
    commit({ ...permissions, spending: next })
  }

  function updateEscalation(patch: Partial<PolicyEscalationConfig>): void {
    const next = { ...(esc ?? {}), ...patch } as PolicyEscalationConfig
    commit({ ...permissions, escalation: next })
  }

  function updateSchedule(patch: Partial<PolicyScheduleConfig>): void {
    const next: PolicyScheduleConfig = { ...sched, ...patch }
    commit({ ...permissions, schedule: next })
  }

  function updateAudit(patch: Partial<PolicyAuditConfig>): void {
    const next: PolicyAuditConfig = { ...audit, ...patch }
    commit({ ...permissions, audit: next })
  }

  return (
    <div>
      <div style={s.card}>
        <label style={s.fieldLabel}>Description</label>
        <textarea
          style={{ ...s.textarea, width: '100%', boxSizing: 'border-box' }}
          rows={2}
          value={agent.description}
          onChange={(e) => onChange({ ...agent, description: e.target.value })}
        />
      </div>

      <div style={s.card}>
        <p style={s.sectionTitle}>1. Accounts</p>
        <Field label="Visible account types">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            {ACCOUNT_TYPES.map((type) => (
              <label key={type} style={s.checkboxRow}>
                <input
                  type="checkbox"
                  checked={(acc?.visible ?? []).includes(type)}
                  onChange={(e) => {
                    const current = acc?.visible ?? []
                    updateAccounts({
                      visible: e.target.checked ? [...current, type] : current.filter((v) => v !== type),
                    })
                  }}
                />
                {type}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Balance visible">
          <CheckboxField checked={acc?.balance} onChange={(v) => updateAccounts({ balance: v })} label="" />
        </Field>
        <Field label="Account number">
          <CheckboxField checked={acc?.account_number} onChange={(v) => updateAccounts({ account_number: v })} label="" />
        </Field>
        <Field label="Routing number">
          <CheckboxField checked={acc?.routing_number} onChange={(v) => updateAccounts({ routing_number: v })} label="" />
        </Field>
      </div>

      <div style={s.card}>
        <p style={s.sectionTitle}>2. Transactions</p>
        <Field label="Can read transactions">
          <CheckboxField checked={tx?.read} onChange={(v) => updateTransactions({ read: v })} label="" />
        </Field>
        <Field label="Lookback days">
          <NumberField value={tx?.lookback_days} placeholder="30" onChange={(v) => updateTransactions({ lookback_days: v })} />
        </Field>
        <Field label="Amount visibility cap ($)">
          <NumberField
            value={tx?.amount_visibility_cap}
            placeholder="No cap"
            onChange={(v) => updateTransactions({ amount_visibility_cap: v })}
          />
        </Field>
        <Field label="Description visible">
          <CheckboxField
            checked={tx?.description_visibility}
            onChange={(v) => updateTransactions({ description_visibility: v })}
            label=""
          />
        </Field>
      </div>

      <div style={s.card}>
        <p style={s.sectionTitle}>3. Spending</p>
        <Field label="Max per transaction ($)">
          <NumberField value={sp.max_per_transaction} onChange={(v) => updateSpending({ max_per_transaction: v })} />
        </Field>
        <Field label="Max daily ($)">
          <NumberField value={sp.max_daily} onChange={(v) => updateSpending({ max_daily: v })} />
        </Field>
        <Field label="Max weekly ($)">
          <NumberField value={sp.max_weekly} onChange={(v) => updateSpending({ max_weekly: v })} />
        </Field>
        <Field label="Max monthly ($)">
          <NumberField value={sp.max_monthly} onChange={(v) => updateSpending({ max_monthly: v })} />
        </Field>
        <Field label="Merchants: allow">
          <TagInput
            values={sp.merchants?.allow ?? []}
            onChange={(v) => updateSpending({ merchants: { ...sp.merchants, allow: v.length ? v : undefined } })}
          />
        </Field>
        <Field label="Merchants: block">
          <TagInput
            values={sp.merchants?.block ?? []}
            onChange={(v) => updateSpending({ merchants: { ...sp.merchants, block: v.length ? v : undefined } })}
          />
        </Field>
        <Field label="Categories: allow">
          <TagInput
            values={sp.categories?.allow ?? []}
            onChange={(v) => updateSpending({ categories: { ...sp.categories, allow: v.length ? v : undefined } })}
          />
        </Field>
        <Field label="Categories: block">
          <TagInput
            values={sp.categories?.block ?? []}
            onChange={(v) => updateSpending({ categories: { ...sp.categories, block: v.length ? v : undefined } })}
          />
        </Field>
        <Field label="Require itemization">
          <CheckboxField
            checked={sp.require_itemization}
            onChange={(v) => updateSpending({ require_itemization: v })}
            label=""
          />
        </Field>
      </div>

      <div style={s.card}>
        <p style={s.sectionTitle}>4. Escalation</p>
        <Field label="Triggers">
          <div>
            {(esc?.triggers ?? []).map((trigger, i) => (
              <TriggerRow
                key={i}
                trigger={trigger}
                onChange={(updated) => {
                  const triggers = [...(esc?.triggers ?? [])]
                  triggers[i] = updated
                  updateEscalation({ triggers })
                }}
                onRemove={() => {
                  const triggers = (esc?.triggers ?? []).filter((_, j) => j !== i)
                  updateEscalation({ triggers })
                }}
              />
            ))}
            <button
              type="button"
              style={s.linkButton}
              onClick={() => updateEscalation({ triggers: [...(esc?.triggers ?? []), { amount_exceeds: 0 }] })}
            >
              + Add trigger
            </button>
          </div>
        </Field>
        <Field label="Channel">
          <select
            style={{ ...s.select, marginBottom: 0 }}
            value={esc?.channel ?? ''}
            onChange={(e) => updateEscalation({ channel: (e.target.value || undefined) as PolicyEscalationConfig['channel'] })}
          >
            <option value="">—</option>
            <option value="cli">CLI</option>
            <option value="webhook">Webhook</option>
          </select>
        </Field>
        <Field label="Timeout">
          <TextField value={esc?.timeout} placeholder="5m" onChange={(v) => updateEscalation({ timeout: v })} />
        </Field>
        <Field label="Default on timeout">
          <select
            style={{ ...s.select, marginBottom: 0 }}
            value={esc?.default_on_timeout ?? ''}
            onChange={(e) =>
              updateEscalation({
                default_on_timeout: (e.target.value || undefined) as PolicyEscalationConfig['default_on_timeout'],
              })
            }
          >
            <option value="">—</option>
            <option value="deny">Deny</option>
            <option value="allow">Allow</option>
          </select>
        </Field>
      </div>

      <div style={s.card}>
        <p style={s.sectionTitle}>5. Schedule</p>
        <Field label="Active hours (HH:MM-HH:MM)">
          <TextField value={sched.active_hours} placeholder="09:00-22:00" onChange={(v) => updateSchedule({ active_hours: v })} />
        </Field>
        <Field label="Active days">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            {DAYS.map((day) => (
              <label key={day} style={s.checkboxRow}>
                <input
                  type="checkbox"
                  checked={(sched.active_days ?? []).includes(day)}
                  onChange={(e) => {
                    const current = sched.active_days ?? []
                    updateSchedule({
                      active_days: e.target.checked ? [...current, day] : current.filter((d) => d !== day),
                    })
                  }}
                />
                {day.slice(0, 3)}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Timezone">
          <select
            style={{ ...s.select, marginBottom: 0 }}
            value={sched.timezone ?? ''}
            onChange={(e) => updateSchedule({ timezone: e.target.value || undefined })}
          >
            <option value="">— none —</option>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Blackout dates (YYYY-MM-DD)">
          <TagInput
            values={sched.blackout_dates ?? []}
            placeholder="2026-12-25"
            onChange={(v) => updateSchedule({ blackout_dates: v.length ? v : undefined })}
          />
        </Field>
        <Field label="Outside schedule">
          <select
            style={{ ...s.select, marginBottom: 0 }}
            value={sched.behavior_outside_schedule ?? ''}
            onChange={(e) =>
              updateSchedule({
                behavior_outside_schedule: (e.target.value || undefined) as PolicyScheduleConfig['behavior_outside_schedule'],
              })
            }
          >
            <option value="">—</option>
            <option value="deny">Deny</option>
            <option value="escalate">Escalate</option>
          </select>
        </Field>
      </div>

      <div style={s.card}>
        <p style={s.sectionTitle}>6. Audit</p>
        <Field label="Log all queries">
          <CheckboxField checked={audit.log_all_queries} onChange={(v) => updateAudit({ log_all_queries: v })} label="" />
        </Field>
        <Field label="Log policy evaluations">
          <CheckboxField
            checked={audit.log_policy_evaluations}
            onChange={(v) => updateAudit({ log_policy_evaluations: v })}
            label=""
          />
        </Field>
        <Field label="Retention">
          <TextField value={audit.retention} placeholder="90d" onChange={(v) => updateAudit({ retention: v })} />
        </Field>
      </div>
    </div>
  )
}

// ---- main component -----------------------------------------------------------

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; doc: PolicyDoc }

export default function PolicyEditor(): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [selected, setSelected] = useState<string | 'global' | null>(null)
  const [addingAgent, setAddingAgent] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [deletingAgent, setDeletingAgent] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveOk, setSaveOk] = useState(false)

  const load = useCallback(async () => {
    setState({ phase: 'loading' })
    const result = await window.clad.getPolicy()
    if (result.ok) {
      setState({ phase: 'ready', doc: result.policy })
    } else {
      setState({ phase: 'error', message: result.error })
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (state.phase === 'loading') {
    return (
      <div style={s.card}>
        <p style={s.mutedText}>Loading policy…</p>
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <div style={s.card}>
        <p style={s.errorText}>Couldn&apos;t load the policy file: {state.message}</p>
        <button type="button" style={s.button} onClick={load}>
          Retry
        </button>
      </div>
    )
  }

  const { doc } = state

  function updateDoc(next: PolicyDoc): void {
    setState({ phase: 'ready', doc: next })
    setSaveOk(false)
    setSaveError(null)
  }

  function updateAgent(id: string, agent: PolicyAgent): void {
    updateDoc({ ...doc, agents: { ...doc.agents, [id]: agent } })
  }

  function addAgent(): void {
    const id = newAgentName.trim()
    if (!id || doc.agents[id]) return
    updateDoc({ ...doc, agents: { ...doc.agents, [id]: { description: '', permissions: {} } } })
    setSelected(id)
    setNewAgentName('')
    setAddingAgent(false)
  }

  function deleteAgent(id: string): void {
    const agents = { ...doc.agents }
    delete agents[id]
    updateDoc({ ...doc, agents })
    if (selected === id) setSelected(null)
    setDeletingAgent(null)
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    setSaveError(null)
    setSaveOk(false)
    try {
      const result = await window.clad.setPolicy(doc)
      if (result.ok) {
        setSaveOk(true)
      } else {
        setSaveError(result.error ?? 'Failed to save.')
      }
    } finally {
      setSaving(false)
    }
  }

  const agentIds = Object.keys(doc.agents)
  const yamlText = stringifyYaml(doc, { lineWidth: 0 })

  return (
    <div>
      <div style={s.card}>
        <h2 style={{ marginTop: 0, marginBottom: 4 }}>Policy editor</h2>
        <p style={s.mutedText}>
          Controls what each AI agent can see and do — visibility, spending limits, and escalation rules. Changes are
          validated against the policy schema and only written to disk once you click Save.
        </p>

        <div style={s.policySidebar}>
          <button
            type="button"
            style={selected === 'global' ? s.policyAgentButtonActive : s.policyAgentButton}
            onClick={() => setSelected('global')}
          >
            Global rules
          </button>
          {agentIds.map((id) => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <button
                type="button"
                style={selected === id ? s.policyAgentButtonActive : s.policyAgentButton}
                onClick={() => setSelected(id)}
              >
                {id}
              </button>
              <button type="button" style={s.tagRemove} aria-label={`Delete agent ${id}`} onClick={() => setDeletingAgent(id)}>
                ×
              </button>
            </span>
          ))}
          {addingAgent ? (
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <input
                autoFocus
                style={{ ...s.input, marginBottom: 0, width: 160 }}
                placeholder="agent-id"
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addAgent()
                  if (e.key === 'Escape') {
                    setAddingAgent(false)
                    setNewAgentName('')
                  }
                }}
              />
              <button type="button" style={s.linkButton} onClick={addAgent}>
                Add
              </button>
            </span>
          ) : (
            <button type="button" style={s.linkButton} onClick={() => setAddingAgent(true)}>
              + Add agent
            </button>
          )}
        </div>

        {deletingAgent && (
          <p style={s.warnText}>
            Delete agent &quot;{deletingAgent}&quot;?{' '}
            <button type="button" style={s.linkButton} onClick={() => deleteAgent(deletingAgent)}>
              Delete
            </button>{' '}
            <button type="button" style={s.linkButton} onClick={() => setDeletingAgent(null)}>
              Cancel
            </button>
          </p>
        )}
      </div>

      {selected === 'global' && <GlobalEditor global={doc.global} onChange={(next) => updateDoc({ ...doc, global: next })} />}

      {selected && selected !== 'global' && doc.agents[selected] && (
        <AgentEditor agent={doc.agents[selected]} onChange={(next) => updateAgent(selected, next)} />
      )}

      {!selected && (
        <div style={s.card}>
          <p style={s.mutedText}>Select Global rules or an agent above to edit its policy.</p>
        </div>
      )}

      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>policy.yaml preview</h3>
          {saveOk && <span style={s.successText}>Saved.</span>}
        </div>
        <pre style={s.yamlPreview}>{yamlText}</pre>
        {saveError && <p style={s.errorText}>{saveError}</p>}
        <div style={{ marginTop: '0.75rem' }}>
          <button type="button" style={s.button} disabled={saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save to disk'}
          </button>
        </div>
      </div>
    </div>
  )
}
