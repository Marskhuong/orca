import { orchestrationMigrationData } from '../../shared/orchestration-rpc-contract'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeClient } from './client'
import type { RemoteRuntimeCompatGate } from './remote-runtime-compat-gate'
import { RuntimeClientError, type RuntimeRpcSuccess } from './types'

export async function checkOrchestrationContractCompatibility(
  client: Pick<RuntimeClient, 'call'>,
  timeoutMs: number,
  verifiedStatus?: RuntimeRpcSuccess<RuntimeStatus>,
  remoteCompat?: Pick<RemoteRuntimeCompatGate, 'noteVerifiedStatus'>
): Promise<void> {
  const response =
    verifiedStatus ?? (await client.call<RuntimeStatus>('status.get', undefined, { timeoutMs }))
  remoteCompat?.noteVerifiedStatus(response.result)
  if (!response.result.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'orchestration_migration_required',
      'The connected Orca runtime does not support the current orchestration contract. No effects were applied.',
      orchestrationMigrationData('runtime_capability_missing')
    )
  }
}
