export type FooterBalance = {
  provider: 'deepseek' | 'jev'
  usedUsd: string
  remainingUsd: string
  provenance: 'meter_balance_ledger' | 'manual_calibrated'
  observedAt: string
}
