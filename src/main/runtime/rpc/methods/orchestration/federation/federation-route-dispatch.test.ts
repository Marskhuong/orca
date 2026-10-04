import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { capacityEvidence } from '../../../../../../shared/orchestration-run-capacity.test-support'

const databases: OrchestrationDb[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  vi.restoreAllMocks()
})

describe('execution-host route gate before federation attachment', () => {
  it.each([
    ['qwen-code', 'READY', 'ROUTE_RETIRED_BY_POLICY'],
    ['codex', undefined, 'ROUTE_NOT_READY'],
    ['codex', 'NOT_READY', 'ROUTE_NOT_READY']
  ] as const)('refuses terminal %s with readiness %s', async (agentIdentity, readiness, code) => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the host identity read by the route gate; refusal assertions verify zero effects.
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_remote',
      worktreeId: 'repo::remote',
      status: 'running',
      agentIdentity
    } as never)
    const create = vi.spyOn(runtime, 'createTerminal')
    const prompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
    const evidence = capacityEvidence('AVAILABLE')
    evidence.RUN_ROUTING_POSTURE.routes.forEach((route) => {
      route.readiness = readiness
    })
    const runsBefore = db.listRuns().runs
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )!
    await expect(
      method.handler(
        method.params!.parse({
          runId: 'run_home',
          capacityEvidence: evidence,
          dispatchId: 'ctx_remote',
          taskId: 'task_remote',
          taskSpec: 'bounded review',
          protocolVersion: 3,
          worktree: 'id:repo::remote',
          terminal: 'term_remote',
          route: 'codex'
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_remote',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'payload_remote'
          }
        }
      )
    ).rejects.toMatchObject({
      code,
      data: {
        effectsApplied: false,
        workerCreated: false,
        routeSelectedByRuntime: false
      }
    })
    expect(db.getRemoteDispatchAttachment('ctx_remote')).toBeUndefined()
    expect(db.listRuns().runs).toEqual(runsBefore)
    expect(create).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })
})
