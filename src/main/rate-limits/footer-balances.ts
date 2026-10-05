import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { FooterBalance } from '../../shared/footer-balance-types'
import { readJevBalance } from '../../cli/jev/jev-balance'
const decimal = z
  .union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/)])
  .transform(Number)
  .refine(Number.isFinite)
const MeterLedger = z.object({
  deepSeekBalance: z.object({
    currency: z.literal('USD'),
    openingBalance: decimal,
    additionsSinceBaseline: decimal,
    baselinePending: z.boolean().optional(),
    lastSuccessAt: z.iso.datetime(),
    lastSample: z.object({ total: decimal })
  })
})
export function parseMeterFooterBalance(input: unknown): FooterBalance | null {
  const parsed = MeterLedger.safeParse(input)
  if (!parsed.success || parsed.data.deepSeekBalance.baselinePending) {
    return null
  }
  const ledger = parsed.data.deepSeekBalance
  return {
    provider: 'deepseek',
    usedUsd: Math.max(
      0,
      ledger.openingBalance + ledger.additionsSinceBaseline - ledger.lastSample.total
    ).toFixed(9),
    remainingUsd: ledger.lastSample.total.toFixed(9),
    provenance: 'meter_balance_ledger',
    observedAt: ledger.lastSuccessAt
  }
}
export async function readFooterBalances(): Promise<FooterBalance[]> {
  const results = await Promise.allSettled([
    readJevBalance(),
    process.platform === 'darwin'
      ? readFile(
          join(
            process.env.ORCA_METER_STORE_DIR ??
              join(homedir(), 'Library', 'Group Containers', 'group.com.mklana.orcameter'),
            'orca-meter-state.json'
          ),
          'utf8'
        ).then((raw) => parseMeterFooterBalance(JSON.parse(raw)))
      : Promise.resolve(null)
  ])
  return results.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : []
  )
}
