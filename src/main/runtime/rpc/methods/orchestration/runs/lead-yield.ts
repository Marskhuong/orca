import { defineMethod } from '../../../core'
import { RunYieldParams } from '../../../../../../shared/rpc-contract/orchestration-runs-params'
import { resolveRunScope } from './run-scope'
import { recordLeadYield, readLeadYieldGuard } from '../../../../orchestration/lead-yield-guard'

export const ORCHESTRATION_LEAD_YIELD_METHODS = [
  defineMethod({
    name: 'orchestration.yield',
    params: RunYieldParams,
    handler: (params, { runtime, orchestrationCaller, orchestrationCompatibilityEvidence }) => {
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        callerSession: orchestrationCaller,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireCurrentConsumer: true
      })
      const db = runtime.getOrchestrationDb()
      const yieldRecorded = recordLeadYield(db, run)
      return {
        runId: run.id,
        yieldRecorded,
        yieldGuard: yieldRecorded ? readLeadYieldGuard(db, run.id) : undefined
      }
    }
  })
]
