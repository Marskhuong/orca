import { z } from 'zod'
import { assertWorkerCanReport } from './worker-report-admission'
import type { OrcaRuntimeService } from '../orca-runtime'
import { agentHookServer } from '../../agent-hooks/server'
import { issueAntigravityCompletion } from '../../agent-hooks/antigravity-completion-capability'
import { registerAntigravityStopCompletion } from '../../agent-hooks/antigravity-stop-completion'
import { sendPointToPointMessage } from '../rpc/methods/orchestration/messaging/send-point-to-point'

export function createAntigravityCompletionCapability(
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
  return capability
}

export async function registerAntigravityWorkerStop(
  runtime: OrcaRuntimeService,
  dispatchId: string
): Promise<void> {
  const authority = runtime.getOrchestrationDispatchAuthority(
    runtime.getOrchestrationDb().getDispatchContextById(dispatchId)?.assignee_handle ?? ''
  )
  if (!authority?.launchTokenHash || !authority.paneKey || authority.hostScope.kind !== 'local') {
    throw new Error('completion_hook_authority_unavailable')
  }
  const terminal = await runtime.showTerminal(authority.terminalHandle)
  if (!terminal.worktreePath || terminal.agentIdentity !== 'antigravity') {
    throw new Error('completion_hook_workspace_unavailable')
  }
  const runtimeId = runtime.getRuntimeId()
  registerAntigravityStopCompletion(authority.paneKey, {
    dispatchId,
    runtimeId,
    launchTokenHash: authority.launchTokenHash,
    model: 'gemini-3.8-flash-high',
    workspacePath: terminal.worktreePath,
    capability: createAntigravityCompletionCapability(runtime, dispatchId),
    assertCurrent: () => {
      const current = runtime.getOrchestrationDispatchAuthority(authority.terminalHandle)
      if (
        runtime.getRuntimeId() !== runtimeId ||
        !current ||
        current.paneKey !== authority.paneKey ||
        current.processIncarnation !== authority.processIncarnation ||
        current.launchTokenHash !== authority.launchTokenHash ||
        current.worktreeId !== authority.worktreeId
      ) {
        throw new Error('completion_hook_authority_changed')
      }
    }
  })
}

export function buildAntigravityCompletionPreamble(args: { taskSpec: string }): string {
  return `You are an Orca governed Antigravity worker. Do only this task.\nOrca observes completion through the provider Stop hook. Do not run completion commands or inspect Orca runtime metadata.\nAfter your final response, idle; no more actions.\n\nTASK:\n${args.taskSpec}`
}
