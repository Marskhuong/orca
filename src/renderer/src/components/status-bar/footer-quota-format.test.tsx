import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { footerQuotaText } from './footer-quota-format'
import { balanceText, balanceTone, FooterBalanceSegment } from './FooterBalanceSegment'
import { getUsageTone, ProviderSegment, UsageOverflowChip } from './StatusBarProviderSegment'
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
const now = Date.now()
const windowOf = (
  usedPercent: number,
  windowMinutes: number,
  minutes: number | null
): RateLimitWindow => ({
  usedPercent,
  windowMinutes,
  resetsAt: minutes === null ? null : now + minutes * 60_000,
  resetDescription: null
})
const provider: ProviderRateLimits = {
  provider: 'claude',
  status: 'ok',
  session: windowOf(40, 300, 135),
  weekly: windowOf(41, 10080, 6960),
  error: null,
  updatedAt: now
}
describe('compact remaining quota footer', () => {
  it('renders both remaining quotas and reset countdowns', () => {
    expect(footerQuotaText(provider, now)).toBe('5h 60% · 2h15m | W 59% · 4d20h')
  })
  it('renders weekly alone without an empty session placeholder', () => {
    expect(footerQuotaText({ ...provider, session: null }, now)).toBe('W 59% · 4d20h')
  })
  it('omits unknown reset times', () => {
    expect(
      footerQuotaText({ ...provider, session: windowOf(40, 300, null), weekly: null }, now)
    ).toBe('5h 60%')
  })
  it('selects one real AGY pool without mixing independent windows', () => {
    const agy: ProviderRateLimits = {
      ...provider,
      provider: 'antigravity',
      buckets: [
        { ...windowOf(1, 300, 282), name: 'Gemini Models · Five Hour Limit Remaining' },
        { ...windowOf(16, 10080, 4800), name: 'Gemini Models · Weekly Limit Remaining' },
        { ...windowOf(80, 300, 30), name: 'Claude and GPT models · Five Hour Limit Remaining' },
        { ...windowOf(2, 10080, 6000), name: 'Claude and GPT models · Weekly Limit Remaining' }
      ]
    }
    expect(footerQuotaText(agy, now)).toBe('P1 5h 20% · 30m | W 98% · 4d4h')
    expect(footerQuotaText(agy, now)).not.toMatch(/Gemini|Models|Limit Remaining/)
  })
  it('keeps consumption tone independent of displayed remaining percentage', () => {
    expect(getUsageTone({ ...provider, session: windowOf(99, 300, null) })).toBe('urgent')
    expect(getUsageTone({ ...provider, session: windowOf(65, 300, null), weekly: null })).toBe(
      'warning'
    )
    expect(getUsageTone({ ...provider, session: windowOf(1, 300, null), weekly: null })).toBe(
      'normal'
    )
  })
  it('footer ignores used preference while detail rendering still follows it', () => {
    const p = { ...provider, session: windowOf(40, 300, null), weekly: null }
    expect(
      renderToStaticMarkup(<ProviderSegment p={p} compact={false} display="used" footer />)
    ).toContain('5h 60%')
    expect(
      renderToStaticMarkup(<ProviderSegment p={p} compact={false} display="used" />)
    ).toContain('40% used')
  })
  it('includes collapsed balance chips in the existing overflow count', () => {
    expect(
      renderToStaticMarkup(
        <UsageOverflowChip hidden={[]} display="remaining" extraHidden={['Jev']} />
      )
    ).toContain('+1')
  })
})
describe('balance footer', () => {
  it('formats authoritative DeepSeek and calibrated Jev values to cents with provenance in details', () => {
    const ds = {
      provider: 'deepseek' as const,
      usedUsd: '4.86',
      remainingUsd: '16.17',
      provenance: 'meter_balance_ledger' as const,
      observedAt: '2026-10-05T06:00:00Z'
    }
    expect(balanceText(ds)).toBe('U $4.86 · R $16.17')
    const jev = {
      ...ds,
      provider: 'jev' as const,
      provenance: 'manual_calibrated' as const,
      usedUsd: '0.42',
      remainingUsd: '9.58'
    }
    expect(balanceText(jev)).toBe('U $0.42 · R $9.58')
    expect(renderToStaticMarkup(<FooterBalanceSegment balance={jev} />)).toContain(
      'manually calibrated'
    )
    expect(balanceTone({ ...jev, usedUsd: '9.9', remainingUsd: '0.1' })).toBe('urgent')
  })
})
