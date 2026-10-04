import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import { RUN_CAPACITY_RUNTIME_CAPABILITY } from '../../../../../../shared/orchestration-run-capacity'
import { z } from 'zod'
import {
  evaluateRouteDispatch,
  ROUTE_DISPATCH_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration-route-dispatch'
import {
  routeDispatchRefusal,
  runCapacityHandshakeRequiredRefusal
} from '../../../../../../shared/orchestration-dispatch-refusal-contract'
import {
  requireRouteDispatchable,
  terminalAgentIdentity
} from '../../../../orchestration/run-capacity-state'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationWorkerServer } from '../../../../orchestration/environment-transport'
import type { WorkerStartInput } from '../worker/worker-start-schema'
import type { FederationAttachStartInput } from './federation-start-schema'

export async function requireFederatedStartRoute(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  params: WorkerStartInput
  server: OrchestrationWorkerServer
  status: RuntimeStatus
  preflightTimeoutMs: number
}): Promise<void> {
  const { runtime, db, runId, params, server, status, preflightTimeoutMs } = args
  const pairingFence = { expectedEnvironmentPairingRevision: server.pairingRevision }
  for (const capability of [RUN_CAPACITY_RUNTIME_CAPABILITY, ROUTE_DISPATCH_RUNTIME_CAPABILITY]) {
    if (status.capabilities?.includes(capability)) {
      continue
    }
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${server.name} must support ${capability} before worker start.`,
      { effectsApplied: false, workerCreated: false, routeSelectedByRuntime: false }
    )
  }
  let terminalAgent: string | undefined
  if (params.terminal) {
    const shown = z
      .object({ terminal: z.object({ agentIdentity: z.string().optional() }) })
      .parse(
        await runtime.callOrchestrationWorkerServer(
          server.environmentId,
          'terminal.show',
          { terminal: params.terminal },
          preflightTimeoutMs,
          undefined,
          pairingFence
        )
      )
    terminalAgent = shown.terminal.agentIdentity
  }
  requireRouteDispatchable(db, runId, {
    route: params.route,
    agent: terminalAgent ?? params.agent,
    model: params.model
  })
}

export async function requireFederationAttachRoute(
  runtime: OrcaRuntimeService,
  params: FederationAttachStartInput,
  agent: string | undefined
): Promise<void> {
  // Why: the execution host checks its own reused agent before attachment or provider effects.
  const refusal = params.capacityEvidence
    ? evaluateRouteDispatch(params.capacityEvidence, {
        route: params.route,
        agent: params.terminal ? await terminalAgentIdentity(runtime, params.terminal) : agent,
        model: params.model
      })
    : null
  const receipt = !params.capacityEvidence
    ? runCapacityHandshakeRequiredRefusal(params.runId ?? 'unrecorded')
    : refusal
      ? routeDispatchRefusal(params.runId ?? 'unrecorded', refusal)
      : null
  if (receipt) {
    throw new OrchestrationError(receipt.code, receipt.message, receipt.data)
  }
}
