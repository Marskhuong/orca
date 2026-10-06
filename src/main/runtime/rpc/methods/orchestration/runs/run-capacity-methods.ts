import { publicAntigravityReadinessReceipt } from '../../../../orchestration/run-capacity-readiness'
import { z } from 'zod'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ANTIGRAVITY_READINESS_MODEL } from '../../../../../antigravity/headless-readiness-response'
import { defineMethod } from '../../../core'
import { resolveRunScope } from './run-scope'
import {
  RunCapacityRecordParams,
  RunCapacityShowParams
} from '../../../../../../shared/orchestration-run-capacity'
import {
  readRunCapacity,
  recordRunCapacity,
  observeAntigravityRunReadiness
} from '../../../../orchestration/run-capacity-state'

export const ORCHESTRATION_RUN_CAPACITY_METHODS = [
  defineMethod({
    name: 'orchestration.runCapacityRecord',
    params: RunCapacityRecordParams,
    handler: async (
      params,
      { runtime, orchestrationCompatibilityEvidence, orchestrationCaller }
    ) => {
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const db = runtime.getOrchestrationDb()
      const probe = params.antigravityProbe
      if (probe) {
        try {
          const readiness = await observeAntigravityRunReadiness({
            db,
            runId: run.id,
            resolveContext: () => runtime.resolveAntigravityReadinessContext(run, probe.worktree)
          })
          return {
            runId: run.id,
            recorded: true,
            readiness: publicAntigravityReadinessReceipt(readiness),
            ...readRunCapacity(db, run.id)
          }
        } catch (error) {
          if (!(error instanceof OrchestrationError) || error.code !== 'ROUTE_NOT_READY') {
            throw error
          }
          const preflight = z
            .object({
              readiness: z.enum(['UNKNOWN', 'NOT_READY']),
              reason: z.string().min(1).max(512),
              inferenceMayConsumeTokens: z.literal(false)
            })
            .safeParse(error.data)
          if (!preflight.success) {
            throw error
          }
          const observedAt = Date.now()
          return {
            runId: run.id,
            recorded: true,
            readiness: {
              readiness: preflight.data.readiness,
              reason: preflight.data.reason,
              observedAt,
              expiresAt: observedAt,
              model: ANTIGRAVITY_READINESS_MODEL,
              inferenceMayConsumeTokens: false,
              cacheHit: false
            },
            ...readRunCapacity(db, run.id)
          }
        }
      }
      const evidence = recordRunCapacity(db, run.id, params.evidence)
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
