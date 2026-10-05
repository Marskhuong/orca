// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { useFooterBalances } from './use-footer-balances'
const balance = {
  provider: 'jev',
  usedUsd: '0.42',
  remainingUsd: '9.58',
  provenance: 'manual_calibrated',
  observedAt: '2026-10-05T06:00:00Z'
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
describe('footer balance snapshots', () => {
  it('updates after the existing quota refresh and removes a missing baseline', async () => {
    const read = vi.fn().mockResolvedValue([balance])
    vi.stubGlobal('api', { rateLimits: { getFooterBalances: read } })
    const { result, rerender } = renderHook((state) => useFooterBalances(state), {
      initialProps: createEmptyRateLimitState()
    })
    await waitFor(() => expect(result.current).toEqual([balance]))
    read.mockResolvedValue([])
    rerender(createEmptyRateLimitState())
    await waitFor(() => expect(result.current).toEqual([]))
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('supports older preloads without inventing a balance', () => {
    vi.stubGlobal('api', { rateLimits: {} })
    const { result } = renderHook(() => useFooterBalances(createEmptyRateLimitState()))
    expect(result.current).toEqual([])
  })
  it('clears unavailable accounting after a failed read', async () => {
    const read = vi.fn().mockRejectedValue(new Error('read unavailable'))
    vi.stubGlobal('api', { rateLimits: { getFooterBalances: read } })
    const { result } = renderHook(() => useFooterBalances(createEmptyRateLimitState()))
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(result.current).toEqual([])
  })
})
