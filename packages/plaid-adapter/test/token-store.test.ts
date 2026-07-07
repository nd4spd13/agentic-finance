import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteTokenStore } from '../src/token-store.js'
import { TokenStoreKeyError } from '../src/errors.js'

const PASSPHRASE = 'correct horse battery staple'
const WRONG_PASSPHRASE = 'incorrect zebra dynamo paperclip'
const SAMPLE_TOKEN = 'access-sandbox-abc123-11112222-3333-4444-5555-666677778888'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clad-token-store-'))
  dbPath = join(dir, 'plaid.sqlite')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function open(passphrase = PASSPHRASE): SqliteTokenStore {
  return new SqliteTokenStore({ dbPath, passphrase })
}

describe('SqliteTokenStore — basic CRUD', () => {
  it('saves and retrieves an access token', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Test Bank', accessToken: SAMPLE_TOKEN })
    expect(store.getAccessToken('item_1')).toBe(SAMPLE_TOKEN)
    store.close()
  })

  it('upserts on repeated saveItem for the same itemId', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Old Name', accessToken: 'access-sandbox-old' })
    const firstCreated = store.listItems()[0].createdAt
    store.saveItem({ itemId: 'item_1', institutionName: 'New Name', accessToken: SAMPLE_TOKEN })

    const items = store.listItems()
    expect(items).toHaveLength(1)
    expect(items[0].institutionName).toBe('New Name')
    expect(items[0].createdAt).toBe(firstCreated) // created_at preserved
    expect(store.getAccessToken('item_1')).toBe(SAMPLE_TOKEN)
    store.close()
  })

  it('deleteItem removes the item and its token', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Test Bank', accessToken: SAMPLE_TOKEN })
    store.deleteItem('item_1')
    expect(store.listItems()).toHaveLength(0)
    expect(() => store.getAccessToken('item_1')).toThrow()
    store.close()
  })

  it('supports multiple items', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Bank A', accessToken: 'access-sandbox-aaa' })
    store.saveItem({ itemId: 'item_2', institutionName: 'Bank B', accessToken: 'access-sandbox-bbb' })
    expect(store.listItems().map((i) => i.itemId).sort()).toEqual(['item_1', 'item_2'])
    expect(store.getAccessToken('item_1')).toBe('access-sandbox-aaa')
    expect(store.getAccessToken('item_2')).toBe('access-sandbox-bbb')
    store.close()
  })
})

describe('SqliteTokenStore — listItems shape (no token leakage)', () => {
  it('returns metadata only, never token-valued fields', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Test Bank', accessToken: SAMPLE_TOKEN })

    const items = store.listItems()
    expect(items).toHaveLength(1)
    const meta = items[0]

    // Exactly the metadata keys, nothing else.
    expect(Object.keys(meta).sort()).toEqual(
      ['createdAt', 'institutionName', 'itemId', 'updatedAt'].sort()
    )

    // Defensive: no value anywhere in the returned object equals or contains the token.
    const serialized = JSON.stringify(items)
    expect(serialized).not.toContain(SAMPLE_TOKEN)
    expect(serialized).not.toContain('access-sandbox')
    store.close()
  })
})

describe('SqliteTokenStore — getAccessToken on missing item', () => {
  it('throws a clean error containing no token material', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Test Bank', accessToken: SAMPLE_TOKEN })
    let caught: unknown
    try {
      store.getAccessToken('does_not_exist')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).not.toContain(SAMPLE_TOKEN)
    expect(message).not.toContain('access-sandbox')
    expect(message).not.toContain(PASSPHRASE)
    store.close()
  })
})

describe('SqliteTokenStore — persistence across reopen', () => {
  it('persists salt and data across close/reopen with the correct passphrase', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Test Bank', accessToken: SAMPLE_TOKEN })
    store.close()

    const reopened = open()
    expect(reopened.getAccessToken('item_1')).toBe(SAMPLE_TOKEN)
    expect(reopened.listItems()[0].institutionName).toBe('Test Bank')
    reopened.close()
  })
})

describe('SqliteTokenStore — wrong passphrase', () => {
  it('throws TokenStoreKeyError when reopened with the wrong passphrase', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Test Bank', accessToken: SAMPLE_TOKEN })
    store.close()

    expect(() => open(WRONG_PASSPHRASE)).toThrow(TokenStoreKeyError)
  })

  it('the TokenStoreKeyError message leaks neither passphrase, key, nor token', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Test Bank', accessToken: SAMPLE_TOKEN })
    store.close()

    let caught: unknown
    try {
      open(WRONG_PASSPHRASE)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TokenStoreKeyError)
    const message = (caught as Error).message
    expect(message).not.toContain(WRONG_PASSPHRASE)
    expect(message).not.toContain(PASSPHRASE)
    expect(message).not.toContain(SAMPLE_TOKEN)
    expect(message).not.toContain('access-sandbox')
    // The serialized error object as a whole must not carry secrets either.
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught))
    expect(serialized).not.toContain(WRONG_PASSPHRASE)
    expect(serialized).not.toContain(PASSPHRASE)
  })
})

describe('SqliteTokenStore — raw file leak check', () => {
  it('does not store the token plaintext anywhere in the DB file bytes', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Test Bank', accessToken: SAMPLE_TOKEN })
    store.close()

    const raw = readFileSync(dbPath)
    // Search the raw bytes for the token substring in common encodings.
    expect(raw.includes(Buffer.from(SAMPLE_TOKEN, 'utf8'))).toBe(false)
    expect(raw.toString('latin1')).not.toContain(SAMPLE_TOKEN)
    expect(raw.toString('utf8')).not.toContain(SAMPLE_TOKEN)
    expect(raw.toString('latin1')).not.toContain('access-sandbox-abc123')
  })
})

describe('SqliteTokenStore — file permissions', () => {
  it('creates the DB file with mode 0600', () => {
    const store = open()
    store.saveItem({ itemId: 'item_1', institutionName: 'Test Bank', accessToken: SAMPLE_TOKEN })
    store.close()
    const mode = statSync(dbPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('re-applies 0600 on reopen if the file mode drifted', () => {
    const store = open()
    store.close()
    // Simulate an operator loosening permissions.
    chmodSync(dbPath, 0o644)
    const reopened = open()
    reopened.close()
    const mode = statSync(dbPath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
