import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { capacityEvidence } from '../../../shared/orchestration-run-capacity.test-support'
import { readRunCapacity, recordRunCapacity } from './run-capacity-state'

describe('Run capacity persistence boundaries', () => {
  let db: OrchestrationDb
  let runId: string
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runId = db.createRun({
      objective: 'any project',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
  })
  afterEach(() => db.close())
  const refusal = { code: 'RUN_CAPACITY_HANDSHAKE_REQUIRED' }
  function start(extra: Record<string, unknown> = {}) {
    return db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 2,
      taskSpec: 'audit',
      taskRunId: runId,
      startOptions: { model: 'explicit-model', agent: 'explicit-provider' },
      ...extra
    })
  }
  it.each(['AVAILABLE', 'CONSTRAINED', 'UNKNOWN', 'UNAVAILABLE'] as const)(
    'accepts %s evidence without routing decisions',
    (availability) => {
      const evidence = capacityEvidence(availability)
      recordRunCapacity(db, runId, evidence)
      const started = start()
      expect(JSON.parse(started.worker.start_options)).toEqual({
        model: 'explicit-model',
        agent: 'explicit-provider'
      })
      expect(readRunCapacity(db, runId)).toEqual(evidence)
      expect(started.worker.state).toBe('starting')
    }
  )

  it('persists an omitted Antigravity participant as UNKNOWN without altering other routes', () => {
    const evidence = capacityEvidence()
    evidence.RUN_ROUTING_POSTURE.routes = evidence.RUN_ROUTING_POSTURE.routes.filter(
      (route) => route.route_identity !== 'antigravity'
    )
    const otherRoutes = evidence.RUN_ROUTING_POSTURE.routes
    const recorded = recordRunCapacity(db, runId, evidence)
    expect(
      recorded.RUN_ROUTING_POSTURE.routes.filter((route) => route.route_identity !== 'antigravity')
    ).toEqual(otherRoutes)
    expect(recorded.RUN_ROUTING_POSTURE.routes.at(-1)).toMatchObject({
      route_identity: 'antigravity',
      availability: 'UNKNOWN',
      availability_source: 'NONE',
      readiness: 'UNKNOWN',
      snapshot_id: 'UNKNOWN'
    })
    expect(readRunCapacity(db, runId)).toEqual(recorded)
    expect(evidence.RUN_ROUTING_POSTURE.routes).toEqual(otherRoutes)
  })
  it('refuses manual dispatch, including substantive injection/reuse, before persistence', () => {
    const task = db.createTask({ runId, spec: 'manual worker' })
    expect(() =>
      db.createDispatchContext({
        taskId: task.id,
        assigneeHandle: 'existing-worker',
        creator: { kind: 'system' },
        maxDepth: 2
      })
    ).toThrowError(expect.objectContaining(refusal))
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })
  it('rolls back inline task and durable acceptance on refusal', () => {
    expect(() =>
      start({
        mutationReceipt: {
          callerFingerprint: 'caller',
          requestId: 'request',
          method: 'orchestration.workerStart',
          payloadHash: 'hash'
        }
      })
    ).toThrowError(expect.objectContaining(refusal))
    expect(db.listTasks({ runId })).toEqual([])
    expect(db.getMutationReceipt('caller', 'request')).toBeUndefined()
    for (const table of ['worker_dispatches', 'dispatch_contexts', 'worker_terminal_resources']) {
      expect(db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
  })
  it('gates retries without changing existing worker state', () => {
    recordRunCapacity(db, runId, capacityEvidence())
    const first = start()
    db.failWorkerStart(first.dispatch.id, 'agent_readiness', 'test failure')
    const existing = db.getWorkerDispatch(first.dispatch.id)
    db.db.prepare('DELETE FROM run_capacity_handshakes WHERE run_id = ?').run(runId)
    expect(() => start({ taskId: first.task.id, retryOf: first.dispatch.id })).toThrowError(
      expect.objectContaining(refusal)
    )
    expect(db.getWorkerDispatch(first.dispatch.id)).toEqual(existing)
    recordRunCapacity(db, runId, capacityEvidence())
    expect(start({ taskId: first.task.id, retryOf: first.dispatch.id }).dispatch.id).not.toBe(
      first.dispatch.id
    )
  })
  it('leaves existing running workers untouched when the next dispatch is refused', () => {
    recordRunCapacity(db, runId, capacityEvidence())
    const first = start()
    db.db.prepare('DELETE FROM run_capacity_handshakes WHERE run_id = ?').run(runId)
    expect(() => start()).toThrowError(expect.objectContaining(refusal))
    expect(db.getWorkerDispatch(first.dispatch.id)).toEqual(first.worker)
    recordRunCapacity(db, runId, capacityEvidence())
    expect(start().dispatch.id).not.toBe(first.dispatch.id)
  })
  it('refuses direct federation attachment before even creating the remote Run', () => {
    expect(() =>
      db.createRemoteDispatchAttachment({
        runId: 'run_remote',
        dispatchId: 'dispatch_remote',
        taskId: 'task_remote',
        homePeerFingerprint: 'peer',
        protocolVersion: 3,
        runtimeEpoch: 'test',
        mutationReceipt: {
          callerFingerprint: 'peer',
          requestId: 'remote',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'hash'
        }
      })
    ).toThrowError(expect.objectContaining(refusal))
    expect(db.getRunRaw('run_remote')).toBeUndefined()
    expect(db.getRemoteDispatchAttachment('dispatch_remote')).toBeUndefined()
    expect(db.getMutationReceipt('peer', 'remote')).toBeUndefined()
  })
  it('imports authenticated home evidence for federated and nested execution', () => {
    const evidence = capacityEvidence()
    const params = {
      runId: 'run_remote',
      dispatchId: 'dispatch_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 3,
      runtimeEpoch: 'test',
      capacityEvidence: evidence,
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'remote',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash'
      }
    }
    db.createRemoteDispatchAttachment(params)
    expect(readRunCapacity(db, 'run_remote')).toEqual(evidence)
    expect(() =>
      db.createRemoteDispatchAttachment({
        ...params,
        dispatchId: 'other',
        homePeerFingerprint: 'foreign',
        mutationReceipt: {
          ...params.mutationReceipt,
          callerFingerprint: 'foreign',
          requestId: 'other'
        }
      })
    ).toThrowError(expect.objectContaining({ code: 'resource_server_mismatch' }))
    expect(start({ taskRunId: 'run_remote' }).worker.state).toBe('starting')
  })
  it('rejects inconsistent evidence and implicit PRESERVED', () => {
    const evidence = capacityEvidence()
    evidence.RUN_ROUTING_POSTURE.routes[0].availability = 'PRESERVED'
    expect(() => recordRunCapacity(db, runId, evidence)).toThrow()
    expect(readRunCapacity(db, runId)).toBeUndefined()
  })
  it('keeps local capacity authoritative during a loopback federation attachment', () => {
    const evidence = capacityEvidence('AVAILABLE')
    recordRunCapacity(db, runId, evidence)
    const home = start()
    db.createRemoteDispatchAttachment({
      runId,
      dispatchId: home.dispatch.id,
      taskId: home.task.id,
      homePeerFingerprint: 'loopback-peer',
      protocolVersion: 3,
      runtimeEpoch: 'test',
      capacityEvidence: capacityEvidence(),
      mutationReceipt: {
        callerFingerprint: 'loopback-peer',
        requestId: 'loopback',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash'
      }
    })
    expect(readRunCapacity(db, runId)).toEqual(evidence)
    expect(db.getRunRaw(runId)?.home_database).toBe('this_database')
  })
  it('rejects a foreign attachment that collides with a registered local Run', () => {
    recordRunCapacity(db, runId, capacityEvidence())
    expect(() =>
      db.createRemoteDispatchAttachment({
        runId,
        dispatchId: 'foreign',
        taskId: 'foreign-task',
        homePeerFingerprint: 'foreign-peer',
        protocolVersion: 3,
        runtimeEpoch: 'test',
        capacityEvidence: capacityEvidence(),
        mutationReceipt: {
          callerFingerprint: 'foreign-peer',
          requestId: 'foreign',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'hash'
        }
      })
    ).toThrowError(expect.objectContaining({ code: 'resource_server_mismatch' }))
    expect(db.getRemoteDispatchAttachment('foreign')).toBeUndefined()
  })
  it('rejects another peer registering a remote Run that predates the gate', () => {
    db.createRemoteDispatchAttachment({
      runId: 'old-remote',
      dispatchId: 'old-dispatch',
      taskId: 'old-task',
      homePeerFingerprint: 'original',
      protocolVersion: 3,
      runtimeEpoch: 'test',
      capacityEvidence: capacityEvidence(),
      mutationReceipt: {
        callerFingerprint: 'original',
        requestId: 'old',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash'
      }
    })
    db.db.prepare('DELETE FROM run_capacity_handshakes WHERE run_id = ?').run('old-remote')
    expect(() => recordRunCapacity(db, 'old-remote', capacityEvidence(), 'different')).toThrowError(
      expect.objectContaining({ code: 'resource_server_mismatch' })
    )
    expect(readRunCapacity(db, 'old-remote')).toBeUndefined()
    recordRunCapacity(db, 'old-remote', capacityEvidence(), 'original')
    expect(readRunCapacity(db, 'old-remote')).toEqual(capacityEvidence())
  })
  it.each(['Green', 'RETOP', 'DCS', 'MK-Lana', 'Aethera', 'Orca Meter', 'Watchdog', 'MCP bridge'])(
    'applies the same invariant to %s',
    (objective) => {
      runId = db.createRun({ objective, coordinatorHandle: null, coordinatorPaneKey: null }).id
      expect(() => start()).toThrowError(expect.objectContaining(refusal))
      recordRunCapacity(db, runId, capacityEvidence())
      expect(start().worker.state).toBe('starting')
    }
  )
})
