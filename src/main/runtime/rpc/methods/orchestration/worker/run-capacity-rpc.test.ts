import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { capacityEvidence } from '../../../../../../shared/orchestration-run-capacity.test-support'
import { recordRunCapacity } from '../../../../orchestration/run-capacity-state'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import * as workerTopology from './worker-topology'
import { eraseRpcMethods } from '../../../core'
import { startFederatedWorker } from '../federation/federated-worker-start'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'

describe('capacity RPC boundaries and disposable Run smoke', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => {
    h.setup()
    h.db.db.prepare('DELETE FROM run_capacity_handshakes').run()
  })
  afterEach(() => h.cleanup())
  const refusal = { code: 'RUN_CAPACITY_HANDSHAKE_REQUIRED' }

  it.each([
    { spec: 'substantive worker', agent: 'codex' },
    { spec: 'reviewer worker', agent: 'claude', taskTitle: 'Review' },
    { spec: 'reuse worker', terminal: 'term_worker' },
    { spec: 'federated worker', on: 'remote', worktree: 'remote-worktree', agent: 'codex' }
  ])('refuses $spec before any allocation or Task creation', async (params) => {
    const remote = vi.spyOn(h.runtime, 'callOrchestrationWorkerServer')
    const worktree = vi.spyOn(h.runtime, 'createManagedWorktree')
    const session = vi.spyOn(workerTopology, 'createStructuredWorkerSessionForWorktree')
    await expect(
      h.call('orchestration.workerStart', { ...params, from: 'term_coord' })
    ).rejects.toMatchObject(refusal)
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(worktree).not.toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
    expect(remote).not.toHaveBeenCalled()
    expect(h.db.listTasks({ runId: h.activeRunId })).toEqual([])
  })
  it('refuses retry of an existing failed worker before allocating another terminal', async () => {
    recordRunCapacity(h.db, h.activeRunId, capacityEvidence())
    const prior = await h.startSettledWorker('failed')
    h.db.db.prepare('DELETE FROM run_capacity_handshakes').run()
    vi.mocked(h.runtime.createTerminal).mockClear()
    await expect(
      h.call('orchestration.workerStart', {
        task: prior.taskId,
        retryOf: prior.dispatchId,
        from: 'term_coord',
        agent: 'codex'
      })
    ).rejects.toMatchObject(refusal)
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  })
  it.each([true, false])('gates manual dispatch with inject=%s', async (inject) => {
    const task = h.db.createTask({ runId: h.activeRunId, spec: 'dispatch' })
    await expect(
      h.call('orchestration.dispatch', {
        task: task.id,
        from: 'term_coord',
        to: 'term_worker',
        inject
      })
    ).rejects.toMatchObject(refusal)
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(h.db.getDispatchContext(task.id)).toBeUndefined()
    expect(h.db.getTask(task.id)?.status).toBe('ready')
  })
  it('permits status, list, evidence reads and dry-run without a handshake', async () => {
    const task = h.db.createTask({ runId: h.activeRunId, spec: 'preview' })
    await expect(h.call('orchestration.runShow', { id: h.activeRunId })).resolves.toBeDefined()
    await expect(h.call('orchestration.workerList', { run: h.activeRunId })).resolves.toBeDefined()
    await expect(
      h.call('orchestration.runCapacityShow', { id: h.activeRunId })
    ).resolves.toMatchObject({ recorded: false })
    await expect(
      h.call('orchestration.dispatch', { task: task.id, from: 'term_coord', dryRun: true })
    ).resolves.toMatchObject({ dryRun: true })
  })
  it.each(['AVAILABLE', 'CONSTRAINED', 'UNKNOWN'] as const)(
    'allows %s with the requested agent',
    async (availability) => {
      await h.call('orchestration.runCapacityRecord', {
        id: h.activeRunId,
        from: 'term_coord',
        evidence: capacityEvidence(availability)
      })
      const started = await h.startWorker({ agent: 'codex' })
      expect(h.db.getWorkerDispatch(started.dispatchId)?.state).toBe('ready')
      expect(h.runtime.createTerminal).toHaveBeenCalledTimes(1)
      expect(JSON.parse(h.db.getWorkerDispatch(started.dispatchId)!.start_options)).toMatchObject({
        agent: 'codex'
      })
    }
  )
  it('refuses a registration from an unbound coordinator', async () => {
    await expect(
      h.call('orchestration.runCapacityRecord', {
        id: h.activeRunId,
        from: 'term_worker',
        evidence: capacityEvidence()
      })
    ).rejects.toBeDefined()
    await expect(
      h.call('orchestration.runCapacityShow', { id: h.activeRunId })
    ).resolves.toMatchObject({ recorded: false })
  })
  it('refuses nested dispatch before creating any child Task or resource', async () => {
    recordRunCapacity(h.db, h.activeRunId, capacityEvidence())
    const parent = await h.startWorker()
    h.db.db.prepare('DELETE FROM run_capacity_handshakes').run()
    vi.mocked(h.runtime.createTerminal).mockClear()
    const run = h.db.createRun({
      objective: 'nested',
      coordinatorHandle: 'term_worker',
      coordinatorPaneKey: h.workerPaneKey
    })
    await expect(
      h.call('orchestration.workerStart', {
        from: 'term_worker',
        spec: 'nested audit',
        agent: 'codex'
      })
    ).rejects.toMatchObject(refusal)
    expect(h.db.listTasks({ runId: run.id })).toEqual([])
    expect(h.db.getWorkerDispatch(parent.dispatchId)?.state).toBe('ready')
  })
  it('returns a structured wire refusal, then succeeds through the registration API', async () => {
    const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: ORCHESTRATION_METHODS })
    const response = await dispatcher.dispatch({
      id: 'capacity-smoke',
      authToken: 'test-token',
      orchestrationRequestId: 'capacity-smoke',
      method: 'orchestration.workerStart',
      params: { from: 'term_coord', spec: 'disposable audit', agent: 'codex' },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    })
    expect(response).toMatchObject({
      error: {
        ...refusal,
        data: {
          runId: h.activeRunId,
          effectsApplied: false,
          workerCreated: false,
          nextSteps: expect.any(Array)
        }
      }
    })
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.db.listTasks({ runId: h.activeRunId })).toEqual([])
    await h.call('orchestration.runCapacityRecord', {
      id: h.activeRunId,
      from: 'term_coord',
      evidence: capacityEvidence()
    })
    expect((await h.startWorker()).dispatchId).toEqual(expect.any(String))
  })
  it('refuses a direct federation RPC without handshake evidence before allocation', async () => {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (m) => m.name === 'orchestration.federationAttachStart'
    )!
    const worktree = vi.spyOn(h.runtime, 'createManagedWorktree')
    await expect(
      method.handler(
        method.params!.parse({
          runId: 'run_remote',
          dispatchId: 'ctx_remote',
          taskId: 'task_remote',
          taskSpec: 'audit',
          protocolVersion: 3,
          worktree: 'remote-workspace',
          agent: 'codex'
        }),
        {
          runtime: h.runtime,
          orchestrationMutation: {
            callerFingerprint: 'peer',
            requestId: 'request',
            method: method.name,
            payloadHash: 'hash'
          }
        }
      )
    ).rejects.toMatchObject(refusal)
    expect(worktree).not.toHaveBeenCalled()
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(h.db.getRunRaw('run_remote')).toBeUndefined()
  })
  it('refuses an older federation host before accepting a worker Dispatch', async () => {
    recordRunCapacity(h.db, h.activeRunId, capacityEvidence())
    vi.spyOn(h.runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'remote',
      name: 'remote',
      peerFingerprint: 'peer',
      pairingRevision: 1
    })
    const remote = vi.spyOn(h.runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      capabilities: [
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
        ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
      ]
    })
    await expect(
      startFederatedWorker({
        params: {
          from: 'term_coord',
          on: 'remote',
          worktree: 'remote-workspace',
          agent: 'codex',
          spec: 'audit'
        },
        runtime: h.runtime,
        db: h.db,
        runId: h.activeRunId,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'old-host',
          method: 'orchestration.workerStart',
          payloadHash: 'hash'
        }
      })
    ).rejects.toMatchObject({ code: 'capability_unsupported', data: { effectsApplied: false } })
    expect(remote).toHaveBeenCalledTimes(1)
    expect(h.db.listTasks({ runId: h.activeRunId })).toEqual([])
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  })
})
