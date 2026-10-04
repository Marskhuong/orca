import { governedDispatchRequiredRefusal } from '../../../shared/orchestration-dispatch-refusal-contract'
import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../shared/orca-session-address'
import type { OrchestrationDb } from '../orchestration/db'
import type { OrchestrationCallerIdentity } from '../orchestration/orchestration-caller-identity'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { resolveOrchestrationParty } from '../orchestration/orchestration-party'
import type { RpcContext } from './core'

/**
 * Refuses an agent launch whose caller participates in an orchestration Run.
 *
 * Why: a Run's coordinator or worker that starts another agent directly would delegate
 * substantive work outside governed dispatch, skipping the capacity and route checks
 * worker-start enforces. Only callers that identify themselves are fenced: UI, mobile, and
 * human shells send no orchestration evidence and are unaffected. Free-form terminal text and
 * commands are never parsed; a caller that strips its own Orca identity leaves Orca's control.
 */
export function assertNotGovernedAgentLaunch(
  context: Pick<
    RpcContext,
    'runtime' | 'orchestrationCaller' | 'orchestrationCompatibilityEvidence'
  >,
  surface: string
): void {
  if (!context.orchestrationCaller && !context.orchestrationCompatibilityEvidence) {
    return
  }
  // Why: a profile with no orchestration database has no Run, so nothing to fence or create.
  const db = context.runtime.getExistingOrchestrationDb()
  const caller = db ? (context.orchestrationCaller ?? declaredCaller(context, db)) : null
  if (!db || !caller) {
    return
  }
  const run = db.getCurrentRunForCoordinator(caller)
  const dispatch = caller.terminalHandle
    ? db.findActiveDispatchForAssignee(caller.terminalHandle, caller.paneKey ?? undefined)
    : undefined
  const participation = run
    ? { runId: run.id, role: 'coordinator' as const }
    : dispatch
      ? { runId: dispatch.run_id, role: 'worker' as const }
      : null
  if (!participation) {
    return
  }
  const receipt = governedDispatchRequiredRefusal({ ...participation, surface })
  throw new OrchestrationError(receipt.code, receipt.message, receipt.data)
}

function declaredCaller(
  context: Pick<RpcContext, 'runtime' | 'orchestrationCompatibilityEvidence'>,
  db: OrchestrationDb
): OrchestrationCallerIdentity | null {
  const evidence = context.orchestrationCompatibilityEvidence
  const sessionId = evidence?.agentSessionId
  try {
    if (typeof sessionId === 'string' && isOrcaSessionId(sessionId)) {
      return resolveOrchestrationParty(formatOrcaSessionAddress(sessionId), db)
    }
    if (evidence?.terminalHandle) {
      const party = resolveOrchestrationParty(evidence.terminalHandle, db)
      // Why: Run binding is pane-keyed; the live pane behind the handle is authoritative, the
      // declared pane key is only a fallback for a handle this host cannot resolve.
      const paneKey =
        party.paneKey ??
        context.runtime.getTerminalPaneKey(evidence.terminalHandle) ??
        evidence.paneKey ??
        null
      return { ...party, paneKey }
    }
  } catch {
    // An unresolvable identity is not a Run participant this host can name.
  }
  return null
}

/** worktree.create fields that start an agent in the new workspace's first terminal. */
export function worktreeCreateStartsAgent(params: Record<string, unknown>): boolean {
  return [
    'startupAgent',
    'startupPrompt',
    'startupCommand',
    'startupLaunchConfig',
    'startupDraft'
  ].some((key) => params[key] !== undefined && params[key] !== null)
}

/** terminal.create fields that make the new terminal an agent launch rather than a shell. */
export function terminalCreateStartsAgent(params: Record<string, unknown>): boolean {
  return ['launchConfig', 'launchAgent', 'resumeProviderSession'].some(
    (key) => params[key] !== undefined && params[key] !== null
  )
}
