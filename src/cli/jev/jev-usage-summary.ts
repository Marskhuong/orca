import { readdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { estimateJevCost, jevUsageDirectory } from './jev-usage-record'

const Record = z.object({
  schema: z.literal('orca/jev-tool-usage/v1'),
  request_id: z.string().uuid(),
  observed_at: z.iso.datetime(),
  effective_model: z.string(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().safe(),
      output_tokens: z.number().int().nonnegative().safe()
    })
    .strict(),
  cost: z.object({
    kind: z.literal('estimated'),
    estimated_usd: z
      .string()
      .regex(/^\d+\.\d{9}$/)
      .nullable()
  })
})
export async function summarizeJevUsage(
  directory = jevUsageDirectory(),
  excludedRequestIds: readonly string[] = [],
  withRequestIds = false
) {
  let calls = 0
  let rejectedRecords = 0
  let inputTokens = 0n
  let outputTokens = 0n
  let nanoUsd = 0n
  let unpricedCalls = 0
  const seen = new Set<string>(excludedRequestIds)
  let files: string[]
  try {
    files = await readdir(directory)
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw new Error('usage_read_failed')
    }
    files = []
  }
  if (files.length > 10_000) {
    throw new Error('usage_read_limit')
  }
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    try {
      const handle = await open(join(directory, file), 'r')
      let raw
      try {
        const buffer = Buffer.alloc(8193)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 8192) {
          throw new Error('record_too_large')
        }
        raw = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
      const record = Record.parse(JSON.parse(raw))
      if (seen.has(record.request_id)) {
        continue
      }
      const expectedCost = estimateJevCost(record.effective_model, record.usage.input_tokens)
      if (record.cost.estimated_usd !== expectedCost) {
        throw new Error('cost_mismatch')
      }
      seen.add(record.request_id)
      calls++
      inputTokens += BigInt(record.usage.input_tokens)
      outputTokens += BigInt(record.usage.output_tokens)
      if (expectedCost === null) {
        unpricedCalls++
      } else {
        nanoUsd += BigInt(expectedCost.replace('.', ''))
      }
    } catch {
      rejectedRecords++
    }
  }
  return {
    status: rejectedRecords ? 'partial' : 'observed',
    calls,
    rejectedRecords,
    inputTokens: inputTokens.toString(),
    outputTokens: outputTokens.toString(),
    estimatedCostUsd: `${nanoUsd / 1_000_000_000n}.${String(nanoUsd % 1_000_000_000n).padStart(9, '0')}`,
    unpricedCalls,
    ...(withRequestIds ? { observedRequestIds: [...seen] } : {}),
    balance: 'NOT_AUTOMATED',
    source: 'locally_observed_jev_tool_calls'
  }
}
