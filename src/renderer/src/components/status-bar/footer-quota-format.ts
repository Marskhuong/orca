import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { clampUsedPercent } from './tooltip'
export function compactReset(resetsAt: number | null, now: number): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) {
    return ''
  }
  const value = formatResetDuration(resetsAt - now)
  return value === 'now' ? '0m' : value.replaceAll(' ', '')
}

function windowText(window: RateLimitWindow, label: string, now: number): string {
  const reset = compactReset(window.resetsAt, now)
  return `${label} ${Math.round(100 - clampUsedPercent(window.usedPercent))}%${reset ? ` · ${reset}` : ''}`
}
export function footerQuotaText(provider: ProviderRateLimits, now: number): string {
  if (provider.provider === 'antigravity' && provider.buckets?.length) {
    const buckets = provider.buckets.filter(
      (bucket) => bucket.windowMinutes === 300 || bucket.windowMinutes === 10080
    )
    const groups = [...new Set(buckets.map((bucket) => bucket.name.split(' · ')[0]))].sort()
    const tightest = [...buckets].sort((a, b) => b.usedPercent - a.usedPercent)[0]
    if (!tightest) {
      return ''
    }
    const group = tightest.name.split(' · ')[0]
    const windows = buckets
      .filter((bucket) => bucket.name.split(' · ')[0] === group)
      .sort((a, b) => a.windowMinutes - b.windowMinutes)
    // Show one actual limiting pool; never pair windows from different AGY pools.
    return `${groups.length > 1 ? `P${groups.indexOf(group) + 1} ` : ''}${windows.map((window) => windowText(window, window.windowMinutes === 300 ? '5h' : 'W', now)).join(' | ')}`
  }
  const windows = [
    provider.session
      ? windowText(
          provider.session,
          provider.session.windowMinutes === 300 ? '5h' : `${provider.session.windowMinutes / 60}h`,
          now
        )
      : '',
    provider.weekly ? windowText(provider.weekly, 'W', now) : ''
  ].filter(Boolean)
  if (!windows.length && provider.monthly) {
    windows.push(windowText(provider.monthly, '30d', now))
  }
  if (!windows.length && provider.buckets?.length) {
    const tightest = [...provider.buckets].sort((a, b) => b.usedPercent - a.usedPercent)[0]
    windows.push(
      windowText(
        tightest,
        tightest.windowMinutes === 10080
          ? 'W'
          : tightest.windowMinutes === 300
            ? '5h'
            : `${tightest.windowMinutes / 60}h`,
        now
      )
    )
  }
  return windows.join(' | ')
}
