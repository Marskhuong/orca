import { USAGE_WARNING_PERCENT, USAGE_URGENT_PERCENT } from './tooltip'
import type { FooterBalance } from '../../../../shared/footer-balance-types'
export function balanceText(balance: FooterBalance): string {
  return `U $${Number(balance.usedUsd).toFixed(2)} · R $${Number(balance.remainingUsd).toFixed(2)}`
}
export function balanceTone(balance: FooterBalance): 'urgent' | 'warning' | 'normal' {
  const remaining = Number(balance.remainingUsd)
  const used = Number(balance.usedUsd)
  const consumed = (used / (used + remaining)) * 100
  return remaining <= 0 || consumed >= USAGE_URGENT_PERCENT
    ? 'urgent'
    : consumed >= USAGE_WARNING_PERCENT
      ? 'warning'
      : 'normal'
}
export function balanceUrgent(balance: FooterBalance): boolean {
  return balanceTone(balance) === 'urgent'
}
export function balanceDetail(balance: FooterBalance): string {
  return balance.provider === 'jev'
    ? `Jev: manually calibrated balance minus tracked estimated spend. Calibrated ${balance.observedAt}. Recalibrate: orca jev balance set --amount <USD>.`
    : `DeepSeek: Orca Meter balance ledger, spend since Meter baseline. Last provider observation ${balance.observedAt}.`
}
export function FooterBalanceSegment({ balance }: { balance: FooterBalance }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 tabular-nums data-[tone=urgent]:text-destructive data-[tone=warning]:text-status-warning"
      data-tone={balanceTone(balance)}
      title={balanceDetail(balance)}
    >
      <span className="text-muted-foreground">{balance.provider === 'jev' ? 'Jev' : 'DS'}</span>
      {balanceText(balance)}
    </span>
  )
}
