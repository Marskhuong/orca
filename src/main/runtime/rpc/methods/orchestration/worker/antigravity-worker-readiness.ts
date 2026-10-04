import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow } from '../../../../orchestration/types'
import type { WorkerStartInput } from './worker-start-schema'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { requireAntigravityRunReadiness } from '../../../../orchestration/run-capacity-state'

export async function resolveAntigravityWorkerReadiness(args: {
  agent: string | undefined
  createsWorktree: boolean
  params: WorkerStartInput
  resolvedWorktreeId?: string
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
}) {
  const { agent, createsWorktree, params, resolvedWorktreeId, runtime, db, run } = args
  if (agent !== 'antigravity') {
    return undefined
  }
  if (
    createsWorktree ||
    params.terminal ||
    !resolvedWorktreeId ||
    params.model !== 'gemini-3.8-flash-high' ||
    params.effort
  ) {
    throw new OrchestrationError(
      'ROUTE_NOT_READY',
      'This Antigravity launch cannot use a bound native readiness receipt.',
      {
        reason: 'unsupported_launch',
        readiness: 'UNKNOWN',
        effectsApplied: false,
        workerCreated: false
      }
    )
  }
  return requireAntigravityRunReadiness(
    db,
    run.id,
    await runtime.resolveAntigravityReadinessContext(run, `id:${resolvedWorktreeId}`)
  )
}
