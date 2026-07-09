import { describe, it, expect } from 'vitest'
import {
  computeBackoffDelayMs,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FACTOR,
  MAX_AUTO_RESTART_ATTEMPTS,
} from '../src/main/lib/mcp-server-manager.js'

describe('computeBackoffDelayMs', () => {
  it('starts at the base delay for attempt 0', () => {
    expect(computeBackoffDelayMs(0)).toBe(BACKOFF_BASE_MS)
  })

  it('grows exponentially by BACKOFF_FACTOR per attempt', () => {
    expect(computeBackoffDelayMs(1)).toBe(BACKOFF_BASE_MS * BACKOFF_FACTOR)
    expect(computeBackoffDelayMs(2)).toBe(BACKOFF_BASE_MS * BACKOFF_FACTOR ** 2)
    expect(computeBackoffDelayMs(3)).toBe(BACKOFF_BASE_MS * BACKOFF_FACTOR ** 3)
  })

  it('is capped and does not grow without bound', () => {
    const uncapped = BACKOFF_BASE_MS * BACKOFF_FACTOR ** 10
    expect(uncapped).toBeGreaterThan(BACKOFF_CAP_MS)
    expect(computeBackoffDelayMs(10)).toBe(BACKOFF_CAP_MS)
    expect(computeBackoffDelayMs(50)).toBe(BACKOFF_CAP_MS)
  })

  it('is monotonically non-decreasing up to the cap', () => {
    let prev = 0
    for (let attempt = 0; attempt < 15; attempt++) {
      const delay = computeBackoffDelayMs(attempt)
      expect(delay).toBeGreaterThanOrEqual(prev)
      prev = delay
    }
  })

  it('MAX_AUTO_RESTART_ATTEMPTS is a small, sane, finite cap', () => {
    expect(MAX_AUTO_RESTART_ATTEMPTS).toBeGreaterThan(0)
    expect(MAX_AUTO_RESTART_ATTEMPTS).toBeLessThan(20)
  })
})
