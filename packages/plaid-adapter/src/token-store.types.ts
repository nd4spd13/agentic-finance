/**
 * Storage contract for encrypted Plaid access tokens.
 *
 * Implementations (see WP3) persist tokens encrypted at rest and must never
 * return token material from any method other than `getAccessToken`. In
 * particular, `listItems` returns metadata only — no `accessToken` field —
 * so this interface can never leak tokens to callers that only need to
 * enumerate connections (e.g. `clad connect` status output).
 *
 * `TokenStore` is intentionally NOT part of `ToolContext`
 * (`packages/mcp-server/src/types.ts`) — MCP tools only ever see the
 * `FinancialDataProvider` interface, never raw token access.
 */

/** Metadata about a stored Plaid Item. Never contains token material. */
export interface StoredItemMeta {
  itemId: string
  institutionName: string
  createdAt: string
  updatedAt: string
}

/** Input for persisting a newly-linked Plaid Item. */
export interface StoredItemInput {
  itemId: string
  institutionName: string
  accessToken: string
}

export interface TokenStore {
  /** Encrypts and persists an item's access token. */
  saveItem(item: StoredItemInput): void

  /** Decrypts and returns the access token for a stored item. */
  getAccessToken(itemId: string): string

  /** Lists metadata for all stored items. Never includes token material. */
  listItems(): StoredItemMeta[]

  /** Removes a stored item and its token. */
  deleteItem(itemId: string): void

  /** Closes the underlying storage handle. */
  close(): void
}
