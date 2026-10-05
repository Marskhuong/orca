import { describe, expect, it } from 'vitest'
import { parseMeterFooterBalance } from './footer-balances'
const input = {
  deepSeekBalance: {
    currency: 'USD',
    openingBalance: 20,
    additionsSinceBaseline: 1.03,
    lastSample: { total: 16.17 },
    lastSuccessAt: '2026-10-05T06:00:00Z'
  }
}
describe('read-only Meter footer projection', () => {
  it('uses authoritative ledger balance and tracked spend including additions', () => {
    expect(parseMeterFooterBalance(input)).toEqual({
      provider: 'deepseek',
      usedUsd: '4.860000000',
      remainingUsd: '16.170000000',
      provenance: 'meter_balance_ledger',
      observedAt: input.deepSeekBalance.lastSuccessAt
    })
  })
  it.each([
    {},
    { deepSeekBalance: { ...input.deepSeekBalance, currency: 'EUR' } },
    { deepSeekBalance: { ...input.deepSeekBalance, baselinePending: true } },
    { deepSeekBalance: { ...input.deepSeekBalance, openingBalance: '' } }
  ])('does not fabricate missing or invalid USD accounting: %j', (invalid) => {
    expect(parseMeterFooterBalance(invalid)).toBeNull()
  })
})
