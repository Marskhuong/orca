import type { RuntimeClient } from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { RuntimeClientError } from '../../runtime-client'
import {
  LEAD_YIELD_RUNTIME_CAPABILITY,
  ParallelWorkReason
} from '../../../shared/orchestration-lead-yield'
import { getOptionalStringFlag } from '../../flags'

export async function parallelWorkEvidence(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
) {
  const value = getOptionalStringFlag(flags, 'parallel-work-reason')
  if (value === undefined) {
    return undefined
  }
  const parsed = ParallelWorkReason.safeParse(value)
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--parallel-work-reason must be nonempty and at most 240 characters.'
    )
  }
  const reason = parsed.data
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(LEAD_YIELD_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This runtime cannot record --parallel-work-reason; update the runtime before using it.'
    )
  }
  return reason
}
