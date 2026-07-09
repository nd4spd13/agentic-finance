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

// ---- D2 nav (Approvals inbox / Audit log viewer) --------------------------

export const navBar: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  marginBottom: '1.25rem',
  borderBottom: '1px solid #ddd',
  paddingBottom: '0.75rem',
}

export const navButton: CSSProperties = {
  padding: '0.4rem 0.75rem',
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

/** A single approval/audit row rendered as a bordered block (reuses `pathList`'s look but with a proportional font — monospace doesn't read well for prose like `triggerReason`). */
export const listItem: CSSProperties = {
  ...pathList,
  fontFamily: 'inherit',
  marginBottom: '0.75rem',
}

/** Applied to the inbox row a clicked notification points at (see `ApprovalsInbox.tsx`'s `focusApprovalId` prop). */
export const listItemHighlighted: CSSProperties = {
  ...listItem,
  border: '2px solid #1a1a1a',
  background: '#fff8e1',
}

export const table: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
}

export const tableHeaderRow: CSSProperties = {
  textAlign: 'left',
  borderBottom: '1px solid #ddd',
}

export const tableCell: CSSProperties = {
  padding: '0.4rem',
}

export const tableRow: CSSProperties = {
  borderBottom: '1px solid #eee',
}

export const filterBar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  marginBottom: '0.75rem',
  alignItems: 'center',
}

export const filterInput: CSSProperties = {
  ...input,
  marginBottom: 0,
  width: 150,
}

export const pagination: CSSProperties = {
  marginTop: '0.75rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
}
