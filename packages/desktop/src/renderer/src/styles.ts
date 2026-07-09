/**
 * Small set of shared inline-style objects for the D1 shell UI. D1's
 * renderer surface is intentionally minimal (settings + server status +
 * connect button — see desktop-app.md's scope note for D1), so this stays a
 * handful of plain objects rather than a component library or CSS
 * framework.
 */
import type { CSSProperties } from 'react'

export const page: CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  padding: '2rem',
  color: '#1a1a1a',
  maxWidth: 720,
  margin: '0 auto',
}

export const card: CSSProperties = {
  background: '#f4f4f4',
  borderRadius: 8,
  padding: '1.25rem',
  marginBottom: '1.25rem',
}

export const label: CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
  color: '#444',
}

export const input: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.5rem',
  fontSize: 14,
  borderRadius: 4,
  border: '1px solid #ccc',
  marginBottom: '0.75rem',
}

export const select: CSSProperties = { ...input }

export const button: CSSProperties = {
  padding: '0.5rem 1rem',
  fontSize: 14,
  borderRadius: 4,
  border: '1px solid #333',
  background: '#1a1a1a',
  color: '#fff',
  cursor: 'pointer',
  marginRight: '0.5rem',
}

export const buttonSecondary: CSSProperties = {
  ...button,
  background: '#fff',
  color: '#1a1a1a',
}

export const buttonDanger: CSSProperties = {
  ...button,
  background: '#fff',
  color: '#b3261e',
  border: '1px solid #b3261e',
}

export const errorText: CSSProperties = {
  color: '#b3261e',
  fontSize: 13,
  marginTop: '0.25rem',
}

export const successText: CSSProperties = {
  color: '#1e7a34',
  fontSize: 13,
  marginTop: '0.25rem',
}

export const mutedText: CSSProperties = {
  color: '#666',
  fontSize: 13,
}

/** Actionable-but-not-an-error notices (e.g. "fell back to X, here's why", "can't unlock stored credentials, re-enter them"). Amber — matches ServerStatusPanel's in-progress state color. */
export const warnText: CSSProperties = {
  color: '#8a6d00',
  fontSize: 13,
  marginTop: '0.25rem',
}

export const pathList: CSSProperties = {
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  background: '#fff',
  border: '1px solid #ddd',
  borderRadius: 4,
  padding: '0.75rem',
  overflowX: 'auto',
}

// ---- D2 nav (introduced by D2.3; D2.4 reuses navButton/navButtonActive) ----

export const nav: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  marginBottom: '1.25rem',
  borderBottom: '1px solid #ddd',
  paddingBottom: '0.75rem',
}

export const navButton: CSSProperties = {
  padding: '0.4rem 0.9rem',
  fontSize: 14,
  borderRadius: 4,
  border: '1px solid transparent',
  background: 'transparent',
  color: '#444',
  cursor: 'pointer',
}

export const navButtonActive: CSSProperties = {
  ...navButton,
  background: '#1a1a1a',
  color: '#fff',
}

// ---- D2.3 dashboard ---------------------------------------------------------

export const listRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.5rem 0',
  borderBottom: '1px solid #e5e5e5',
  fontSize: 14,
}

export const amountNegative: CSSProperties = {
  color: '#b3261e',
  fontVariantNumeric: 'tabular-nums',
}

export const amountPositive: CSSProperties = {
  color: '#1e7a34',
  fontVariantNumeric: 'tabular-nums',
}

// ---- D2.4 policy editor ------------------------------------------------------

export const textarea: CSSProperties = {
  ...input,
  fontFamily: 'inherit',
  resize: 'vertical',
}

export const fieldRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.75rem',
  marginBottom: '0.6rem',
}

export const fieldLabel: CSSProperties = {
  width: 200,
  flexShrink: 0,
  fontSize: 13,
  color: '#555',
  paddingTop: 6,
}

export const fieldControl: CSSProperties = {
  flex: 1,
  minWidth: 0,
}

export const sectionTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: '#666',
  margin: '0 0 0.5rem',
}

export const checkboxRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  fontSize: 13,
  cursor: 'pointer',
}

export const tagInputWrap: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.35rem',
  alignItems: 'center',
  border: '1px solid #ccc',
  borderRadius: 4,
  padding: '0.35rem 0.5rem',
  background: '#fff',
  minHeight: 34,
  boxSizing: 'border-box',
}

export const tag: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: '#e0e7ff',
  color: '#3730a3',
  borderRadius: 4,
  padding: '2px 6px',
  fontSize: 12,
}

export const tagRemove: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#6366f1',
  cursor: 'pointer',
  lineHeight: 1,
  padding: 0,
  fontSize: 13,
}

export const tagInputField: CSSProperties = {
  flex: 1,
  minWidth: 80,
  border: 'none',
  outline: 'none',
  fontSize: 13,
}

export const linkButton: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#4f46e5',
  cursor: 'pointer',
  fontSize: 13,
  padding: 0,
}

export const policySidebar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.4rem',
  marginBottom: '1rem',
}

export const policyAgentButton: CSSProperties = {
  padding: '0.35rem 0.75rem',
  fontSize: 13,
  borderRadius: 999,
  border: '1px solid #ccc',
  background: '#fff',
  color: '#333',
  cursor: 'pointer',
}

export const policyAgentButtonActive: CSSProperties = {
  ...policyAgentButton,
  background: '#4f46e5',
  borderColor: '#4f46e5',
  color: '#fff',
}

export const yamlPreview: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  background: '#1a1a1a',
  color: '#e5e5e5',
  borderRadius: 6,
  padding: '0.75rem',
  overflow: 'auto',
  maxHeight: 260,
  whiteSpace: 'pre',
  margin: 0,
}

export const triggerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.5rem',
}
