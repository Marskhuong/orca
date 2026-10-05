import { z } from 'zod'
import { assertWorkerCanReport } from './worker-report-admission'
import type { OrcaRuntimeService } from '../orca-runtime'
import { agentHookServer } from '../../agent-hooks/server'
import {
  issueAntigravityCompletion,
  ANTIGRAVITY_COMPLETION_PATH
} from '../../agent-hooks/antigravity-completion-capability'
import { sendPointToPointMessage } from '../rpc/methods/orchestration/messaging/send-point-to-point'

export function antigravityCompletionCommand(
  runtime: OrcaRuntimeService,
  dispatchId: string
): string {
  const db = runtime.getOrchestrationDb()
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch?.assignee_handle || !dispatch.assignee_pane_key || !dispatch.process_incarnation) {
    throw new Error('completion_identity_unavailable')
  }
  const handle = dispatch.assignee_handle
  const paneKey = dispatch.assignee_pane_key
  const incarnation = dispatch.process_incarnation
  const runtimeId = runtime.getRuntimeId()
  const port = Number(agentHookServer.buildPtyEnv().ORCA_AGENT_HOOK_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('completion_transport_unavailable')
  }
  const capability = issueAntigravityCompletion({
    dispatchId,
    runtimeId,
    complete: (report) => {
      const current = db.getDispatchContextById(dispatchId)
      if (
        runtime.getRuntimeId() !== runtimeId ||
        !current ||
        !['pending', 'dispatched', 'blocked'].includes(current.status) ||
        current.assignee_handle !== handle ||
        current.assignee_pane_key !== paneKey ||
        runtime.getTerminalProcessIncarnation(handle) !== incarnation
      ) {
        throw new Error('completion_worker_inactive')
      }
      const worker = db.getWorkerDispatch(dispatchId)
      if (!worker) {
        throw new Error('completion_worker_missing')
      }
      assertWorkerCanReport({
        dispatchId,
        from: handle,
        workerState: worker.state,
        processCurrent: db.isDispatchProcessCurrent({
          dispatchId,
          paneKey,
          processIncarnation: incarnation
        })
      })
      const receipt = sendPointToPointMessage({
        runtime,
        db,
        from: handle,
        to: `run:${current.run_id}`,
        dispatchId,
        messageRunId: current.run_id,
        senderPaneKey: paneKey,
        legacyCoordinatorRunId: undefined,
        revalidateLegacyCoordinator: undefined,
        recordMutationReceipt: undefined,
        markWorkerDoneMutationEffectFree: undefined,
        resolveProcessIncarnation: () => incarnation,
        withSendWarnings: (receipt) => receipt,
        params: {
          from: handle,
          subject: 'Antigravity worker completed',
          type: 'worker_done',
          body: report.summary ?? '',
          payload: JSON.stringify({ taskId: current.task_id, dispatchId, outcome: report.outcome })
        }
      })
      const settled = z
        .object({
          lifecycle: z.object({
            action: z.enum(['completed', 'failed']),
            dispatchId: z.literal(dispatchId)
          })
        })
        .safeParse(receipt)
      if (!settled.success) {
        throw new Error('completion_not_settled')
      }
    }
  })
  return `orca orchestration complete --dispatch-id ${dispatchId} --runtime-id ${runtimeId} --endpoint http://127.0.0.1:${port}${ANTIGRAVITY_COMPLETION_PATH} --dispatch-capability ${capability}`
}

export function buildAntigravityCompletionPreamble(args: {
  command: string
  taskSpec: string
}): string {
  return `You are an Orca governed Antigravity worker. Do only this task.\nWhen finished, report exactly once using this completion-only command:\n${args.command} --outcome succeeded --summary "<brief result>"\nUse --outcome failed for failure. This one-shot capability expires in five minutes.\nDo not use orchestration send or inspect Orca runtime metadata. Do not request sandbox bypass.\nAfter completion, idle; no more actions.\n\nTASK:\n${args.taskSpec}`
}
