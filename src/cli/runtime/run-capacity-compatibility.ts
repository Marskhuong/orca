import { RUN_CAPACITY_RUNTIME_CAPABILITY } from '../../shared/orchestration-run-capacity'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeClient } from './client'
import { RuntimeClientError } from './types'

export async function ensureRunCapacityCompatible(
  client: Pick<RuntimeClient, 'call'>,
  method: string,
  timeoutMs: number,
  verifiedStatus?: RuntimeStatus
): Promise<void> {
  if (method !== 'orchestration.runCapacityRecord' && method !== 'orchestration.runCapacityShow') {
    return
  }
  const status =
    verifiedStatus ??
    (await client.call<RuntimeStatus>('status.get', undefined, { timeoutMs })).result
  if (!status.capabilities?.includes(RUN_CAPACITY_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      `The connected Orca runtime must support ${RUN_CAPACITY_RUNTIME_CAPABILITY}. No effects were applied.`,
      { capability: RUN_CAPACITY_RUNTIME_CAPABILITY, effectsApplied: false, workerCreated: false }
    )
  }
}
