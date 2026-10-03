import { defineMethod } from '../../../core'
import { resolveRunScope } from './run-scope'
import {
  RunCapacityRecordParams,
  RunCapacityShowParams
} from '../../../../../../shared/orchestration-run-capacity'
import { readRunCapacity, recordRunCapacity } from '../../../../orchestration/run-capacity-state'

export const ORCHESTRATION_RUN_CAPACITY_METHODS = [
  defineMethod({
    name: 'orchestration.runCapacityRecord',
    params: RunCapacityRecordParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence, orchestrationCaller }) => {
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const evidence = recordRunCapacity(runtime.getOrchestrationDb(), run.id, params.evidence)
      return { runId: run.id, recorded: true, ...evidence }
    }
  }),
  defineMethod({
    name: 'orchestration.runCapacityShow',
    params: RunCapacityShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      db.requireRun(params.id)
      const evidence = readRunCapacity(db, params.id)
      return {
        runId: params.id,
        recorded: !!evidence,
        RUN_CAPACITY_SNAPSHOT_ID: null,
        RUN_ROUTING_POSTURE: null,
        ...evidence
      }
    }
  })
]
