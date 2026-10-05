import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomically } from '../../main/codex-accounts/fs-utils'
import { jevUsageDirectory } from './jev-usage-record'
import { summarizeJevUsage } from './jev-usage-summary'

const Baseline = z
  .object({
    schema: z.literal('orca/jev-balance/v1'),
    provenance: z.literal('manual_calibrated'),
    calibratedAt: z.iso.datetime(),
    amountNanoUsd: z.string().regex(/^\d+$/).max(18),
    accountedRequestIds: z.array(z.string().uuid()).max(10_000)
  })
  .strict()
const baselinePath = (directory: string) => join(directory, 'balance-baseline.state')
export function formatNanoUsd(value: bigint): string {
  const absolute = value < 0n ? -value : value
  return `${value < 0n ? '-' : ''}${absolute / 1_000_000_000n}.${String(absolute % 1_000_000_000n).padStart(9, '0')}`
}
export async function setJevBalance(amount: string, directory = jevUsageDirectory()) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(amount)) {
    throw new Error('INVALID_BALANCE_AMOUNT')
  }
  const [whole, fractional = ''] = amount.split('.')
  const amountNanoUsd =
    BigInt(whole) * 1_000_000_000n + BigInt(fractional.padEnd(2, '0')) * 10_000_000n
  const usage = await summarizeJevUsage(directory, [], true)
  if (usage.rejectedRecords || usage.unpricedCalls) {
    throw new Error('USAGE_NOT_FULLY_ACCOUNTED')
  }
  const baseline = Baseline.parse({
    schema: 'orca/jev-balance/v1',
    provenance: 'manual_calibrated',
    calibratedAt: new Date().toISOString(),
    amountNanoUsd: amountNanoUsd.toString(),
    accountedRequestIds: usage.observedRequestIds
  })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  writeFileAtomically(baselinePath(directory), `${JSON.stringify(baseline)}\n`, { mode: 0o600 })
  return {
    status: 'calibrated',
    provenance: baseline.provenance,
    calibratedAt: baseline.calibratedAt,
    balanceUsd: formatNanoUsd(amountNanoUsd)
  }
}
export async function readJevBalance(directory = jevUsageDirectory()) {
  let baseline
  try {
    baseline = Baseline.parse(JSON.parse(await readFile(baselinePath(directory), 'utf8')))
  } catch {
    return null
  }
  // Calibration excludes records already visible; later journal records count even if inference began earlier.
  const usage = await summarizeJevUsage(directory, baseline.accountedRequestIds)
  if (usage.rejectedRecords || usage.unpricedCalls) {
    return null
  }
  const spent = BigInt(usage.estimatedCostUsd.replace('.', ''))
  return {
    provider: 'jev' as const,
    usedUsd: formatNanoUsd(spent),
    remainingUsd: formatNanoUsd(BigInt(baseline.amountNanoUsd) - spent),
    provenance: baseline.provenance,
    observedAt: baseline.calibratedAt
  }
}
