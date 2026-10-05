import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JevDecisionResult } from './system-one-decision'
import { getDefaultUserDataPath } from '../runtime/metadata'

export const JEV_PRICING_SOURCE = 'https://docs.typesafe.ai/models'
export function estimateJevCost(model: string, inputTokens: number): string | null {
  if (
    model !== 'jev-1.13.0' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(inputTokens * 42)
  ) {
    return null
  }
  const nanoUsd = BigInt(inputTokens) * 42n
  return `${nanoUsd / 1_000_000_000n}.${String(nanoUsd % 1_000_000_000n).padStart(9, '0')}`
}
export function jevUsageDirectory(): string {
  return process.env.ORCA_JEV_USAGE_DIRECTORY ?? join(getDefaultUserDataPath(), 'jev-tool-usage')
}
export async function recordJevUsage(
  result: Extract<JevDecisionResult, { status: 'succeeded' }>,
  directory = jevUsageDirectory()
) {
  const estimatedCostUsd = estimateJevCost(result.effectiveModel, result.usage.input_tokens)
  const record = {
    schema: 'orca/jev-tool-usage/v1',
    request_id: result.requestId,
    observed_at: new Date().toISOString(),
    effective_model: result.effectiveModel,
    usage: result.usage,
    duration_ms: result.durationMs,
    cost: {
      kind: 'estimated',
      estimated_usd: estimatedCostUsd,
      pricing_source: JEV_PRICING_SOURCE,
      pricing_version: 'jev-1.13.0:2026-10-05',
      input_usd_per_million: '0.042',
      output_usd_per_million: '0'
    },
    balance: 'NOT_AUTOMATED'
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, `${result.requestId}.json`), `${JSON.stringify(record)}\n`, {
      flag: 'wx',
      mode: 0o600
    })
    return {
      status: 'recorded',
      estimatedCostUsd,
      kind: 'estimated',
      pricingSource: JEV_PRICING_SOURCE,
      balance: 'NOT_AUTOMATED'
    }
  } catch {
    return {
      status: 'recording_failed',
      estimatedCostUsd,
      kind: 'estimated',
      pricingSource: JEV_PRICING_SOURCE,
      balance: 'NOT_AUTOMATED'
    }
  }
}
