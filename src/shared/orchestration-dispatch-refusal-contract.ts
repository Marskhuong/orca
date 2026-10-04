import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { RouteDispatchRefusal, RouteDispatchRefusalCode } from './orchestration-route-dispatch'

// Why: one source for each dispatch refusal's code, message, and data, so the runtime emits and
// the CLI test formats the identical envelope. Messages are supplied per call site because each
// existing string is a published receipt an old consumer may match on.

export type DispatchRefusalReceipt = {
  code:
    | 'task_not_found'
    | 'task_not_startable'
    | 'inject_rejected'
    | 'RUN_CAPACITY_HANDSHAKE_REQUIRED'
    | RouteDispatchRefusalCode
    | 'GOVERNED_DISPATCH_REQUIRED'
  message: string
  data: Record<string, unknown> & { nextSteps: string[] }
}

export function runCapacityHandshakeRequiredRefusal(runId: string): DispatchRefusalReceipt {
  return {
    code: 'RUN_CAPACITY_HANDSHAKE_REQUIRED',
    message: `Run ${runId} requires a recorded capacity handshake before substantive dispatch.`,
    data: {
      runId,
      effectsApplied: false,
      workerCreated: false,
      nextSteps: [
        'Read Orca Meter capacity evidence, complete the Run capacity handshake, and record RUN_CAPACITY_SNAPSHOT_ID and RUN_ROUTING_POSTURE with orca orchestration run-capacity-record --id <run_id> --evidence <json> --json.',
        'Retry the substantive dispatch after registration succeeds. UNKNOWN capacity evidence satisfies the gate.'
      ]
    }
  }
}

const ROUTE_REFUSAL_MESSAGES: Record<RouteDispatchRefusalCode, string> = {
  ROUTE_RETIRED_BY_POLICY: 'is retired by Product Owner policy and is never dispatchable',
  ROUTE_CAPACITY_NOT_AUTHORIZED: 'is not capacity-authorized by the Run routing posture',
  ROUTE_NOT_READY: 'is not recorded READY in the Run routing posture',
  ROUTE_IDENTITY_REQUIRED: 'must name a route recorded in the Run routing posture'
}

const ROUTE_REFUSAL_NEXT_STEPS: Record<RouteDispatchRefusalCode, string> = {
  ROUTE_RETIRED_BY_POLICY:
    'Choose another capable and eligible route. A retired route is policy-ineligible and is not a capacity state.',
  ROUTE_CAPACITY_NOT_AUTHORIZED:
    'Choose a route the Run posture authorizes, or record updated capacity evidence for this route with orca orchestration run-capacity-record --id <run_id> --evidence <json> --json.',
  ROUTE_NOT_READY:
    "Record this route's one bounded readiness check result as readiness READY in RUN_ROUTING_POSTURE, or choose the next capable and eligible route and record ROUTING_FALLBACK_REASON.",
  ROUTE_IDENTITY_REQUIRED:
    'Retry worker-start with --route <route_identity> naming a route in the Run posture.'
}

/** The coordinator owns route choice; this refusal names the problem and never a replacement. */
export function routeDispatchRefusal(
  runId: string,
  refusal: RouteDispatchRefusal
): DispatchRefusalReceipt {
  const subject = refusal.route ? `Route ${refusal.route}` : 'This dispatch'
  return {
    code: refusal.code,
    message: `${subject} ${ROUTE_REFUSAL_MESSAGES[refusal.code]} in Run ${runId}. No worker or provider effect was applied.`,
    data: {
      runId,
      route: refusal.route,
      reason: refusal.reason,
      ...(refusal.readiness ? { readiness: refusal.readiness } : {}),
      ...(refusal.readinessReason ? { readinessReason: refusal.readinessReason } : {}),
      ...(refusal.availability ? { availability: refusal.availability } : {}),
      effectsApplied: false,
      workerCreated: false,
      routeSelectedByRuntime: false,
      nextSteps: [ROUTE_REFUSAL_NEXT_STEPS[refusal.code]]
    }
  }
}

export type GovernedLaunchCaller = {
  runId: string
  role: 'coordinator' | 'worker'
  surface: string
}

export function governedDispatchRequiredRefusal(
  caller: GovernedLaunchCaller
): DispatchRefusalReceipt {
  return {
    code: 'GOVERNED_DISPATCH_REQUIRED',
    message: `This ${caller.role} belongs to Run ${caller.runId}; ${caller.surface} cannot start an additional agent outside governed dispatch. No agent, terminal, or worktree was created.`,
    data: {
      runId: caller.runId,
      role: caller.role,
      surface: caller.surface,
      effectsApplied: false,
      workerCreated: false,
      nextSteps: [
        'Start substantive worker, reviewer, or delegated agent execution with orca orchestration worker-start --task <task_id> --route <route_identity> --json.',
        'If governed dispatch is refused, keep the refusal visible; do not substitute a direct agent or provider launch.'
      ]
    }
  }
}

export function taskNotFoundRefusal(
  message: string,
  detail: { taskId: string; runId?: string }
): DispatchRefusalReceipt {
  return {
    code: 'task_not_found',
    message,
    data: {
      ...detail,
      nextSteps: [
        'Run orca orchestration task-list --json in the bound Run to find the intended Task id.',
        'If the Task does not exist yet, create it with orca orchestration task-create --spec <text> --json.'
      ]
    }
  }
}

export type TaskNotStartableDetail = {
  taskId: string
  status: string
  unmetDependencies: string[]
  retryOf?: string
}

export function taskNotStartableRefusal(
  message: string,
  detail: TaskNotStartableDetail
): DispatchRefusalReceipt {
  return {
    code: 'task_not_startable',
    message,
    data: { ...detail, nextSteps: taskNotStartableNextSteps(detail) }
  }
}

function taskNotStartableNextSteps(detail: TaskNotStartableDetail): string[] {
  if (detail.retryOf) {
    return [
      `--retry-of must name the latest settled Dispatch of a failed or blocked Task; check orca orchestration dispatch-show --task ${detail.taskId} --json and orca orchestration worker-show --dispatch ${detail.retryOf} --json.`
    ]
  }
  if (detail.unmetDependencies.length > 0) {
    return [
      `Dependencies ${detail.unmetDependencies.join(', ')} are not completed. Wait for running ones with orca orchestration check --wait --json; retry or unblock failed ones before dispatching again.`
    ]
  }
  if (detail.status === 'dispatched') {
    return [
      `The Task already has an active Dispatch; inspect it with orca orchestration dispatch-show --task ${detail.taskId} --json.`
    ]
  }
  return [
    `A ${detail.status} Task cannot be dispatched; create a new Task or use worker-start --retry-of for a failed attempt.`
  ]
}

// Why: the old five-name example read as an allowlist (#15125); derive from the field detection keys on so it cannot drift.
// Not filtered by `disabledTuiAgents` — that gates Orca's launchers, not detection, so a hand-started disabled agent still injects.
const RECOGNIZED_AGENT_PROCESS_NAMES = [
  ...new Set(Object.values(TUI_AGENT_CONFIG).map((config) => config.expectedProcess))
].sort()

export function buildInjectRejectionMessage(terminal: string): string {
  return (
    `Cannot dispatch --inject to terminal ${terminal}: no recognized agent detected. ` +
    `Orca detects these agent CLIs (${RECOGNIZED_AGENT_PROCESS_NAMES.join(', ')}). ` +
    'Start one in the terminal and let it finish launching, ' +
    'or dispatch without --inject and send the prompt manually.'
  )
}

export type InjectRejectionReason = 'no_agent_detected'

export function injectRejectedRefusal(
  terminal: string,
  reason: InjectRejectionReason
): DispatchRefusalReceipt {
  return {
    code: 'inject_rejected',
    message: buildInjectRejectionMessage(terminal),
    data: {
      terminal,
      reason,
      nextSteps: [
        'Start a recognized agent CLI in that terminal and wait for it to finish launching, or pick a terminal that already runs one.',
        'Alternatively dispatch without --inject and deliver the prompt with orca terminal send --terminal <handle> --text <prompt> --enter --json.'
      ]
    }
  }
}
