import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { capacityEvidence } from '../../../shared/orchestration-run-capacity.test-support'
import {
  observeAntigravityRunReadiness,
  readRunCapacity,
  recordRunCapacity,
  requireAntigravityRunReadiness,
  requireRouteDispatchable
} from './run-capacity-state'
import { publicAntigravityReadinessReceipt } from './run-capacity-readiness'
import type { NativeAntigravityReadinessContext } from '../../antigravity/native-readiness-launch-context'

const initialContext: NativeAntigravityReadinessContext = {
  runId: 'fixture',
  generation: 1,
  fingerprint: 'run-runtime-workspace-account-config',
  program: '/audited/agy',
  cwd: '/existing-folder',
  env: {},
  command: 'agy',
  launchConfig: { agentCommand: 'agy', agentArgs: '', agentEnv: {} }
}

describe('runtime-owned AGY readiness receipts', () => {
  let db: OrchestrationDb
  let runId: string
  let context: NativeAntigravityReadinessContext
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runId = db.createRun({
      objective: 'receipt test',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
    context = {
      ...initialContext,
      runId,
      generation: db.getRunRaw(runId)?.consumer_generation ?? 0
    }
    recordRunCapacity(db, runId, capacityEvidence())
  })
  afterEach(() => db.close())

  it('refuses caller READY without runtime authority and route laundering', () => {
    for (const request of [
      { agent: 'antigravity' },
      { agent: 'antigravity', route: 'claude' },
      { agent: 'antigravity', model: 'claude/exact' }
    ]) {
      expect(() => requireRouteDispatchable(db, runId, request)).toThrowError(
        expect.objectContaining({ code: 'ROUTE_NOT_READY' })
      )
    }
    expect(() => requireAntigravityRunReadiness(db, runId, context)).toThrowError(
      expect.objectContaining({ code: 'ROUTE_NOT_READY' })
    )
    expect(db.listTasks({ runId })).toEqual([])
  })

  it('caches a completed observation without changing capacity or allocating', async () => {
    const time = Date.now()
    const before = readRunCapacity(db, runId)
    const observe = vi.fn(async () => ({
      readiness: 'READY' as const,
      reason: 'inference_completed'
    }))
    const args = { db, runId, resolveContext: async () => context, observe, now: () => time }
    const receipt = await observeAntigravityRunReadiness(args)
    expect(receipt).toMatchObject({
      readiness: 'READY',
      expiresAt: time + 120000,
      cacheHit: false,
      inferenceMayConsumeTokens: true
    })
    expect(await observeAntigravityRunReadiness(args)).toMatchObject({
      receiptId: receipt.receiptId,
      cacheHit: true
    })
    expect(observe).toHaveBeenCalledOnce()
    expect(requireAntigravityRunReadiness(db, runId, context, time + 1)).toBe(context)
    expect(() => requireAntigravityRunReadiness(db, runId, context, time + 120000)).toThrowError(
      expect.objectContaining({ code: 'ROUTE_NOT_READY' })
    )
    expect(() =>
      requireAntigravityRunReadiness(
        db,
        runId,
        { ...context, runId: 'fixture', generation: 1, fingerprint: 'different' },
        time + 1
      )
    ).toThrowError(expect.objectContaining({ code: 'ROUTE_NOT_READY' }))
    const after = readRunCapacity(db, runId)
    expect(after?.RUN_CAPACITY_SNAPSHOT_ID).toEqual(before?.RUN_CAPACITY_SNAPSHOT_ID)
    expect(after?.RUN_ROUTING_POSTURE.routes.map((entry) => entry.availability)).toEqual(
      before?.RUN_ROUTING_POSTURE.routes.map((entry) => entry.availability)
    )
    expect(db.listTasks({ runId })).toEqual([])
  })

  it('caches UNKNOWN and does not retry the provider', async () => {
    const observe = vi.fn(async () => ({ readiness: 'UNKNOWN' as const, reason: 'timeout' }))
    const args = { db, runId, resolveContext: async () => context, observe }
    expect(await observeAntigravityRunReadiness(args)).toMatchObject({
      readiness: 'UNKNOWN',
      cacheHit: false
    })
    expect(await observeAntigravityRunReadiness(args)).toMatchObject({
      readiness: 'UNKNOWN',
      cacheHit: true
    })
    expect(observe).toHaveBeenCalledOnce()
    expect(() => requireAntigravityRunReadiness(db, runId, context)).toThrowError(
      expect.objectContaining({ code: 'ROUTE_NOT_READY' })
    )
  })

  it('rejects a changed identity after the inference without a retry', async () => {
    const resolveContext = vi
      .fn()
      .mockResolvedValueOnce(context)
      .mockResolvedValueOnce({
        ...context,
        runId: 'fixture',
        generation: 1,
        fingerprint: 'changed'
      })
    const observe = vi.fn(async () => ({
      readiness: 'READY' as const,
      reason: 'inference_completed'
    }))
    expect(
      await observeAntigravityRunReadiness({ db, runId, resolveContext, observe })
    ).toMatchObject({ readiness: 'UNKNOWN', reason: 'identity_changed' })
    expect(observe).toHaveBeenCalledOnce()
  })
  it('coalesces concurrent checks and restores posture after a public rerecord without another inference', async () => {
    let complete: (value: { readiness: 'READY'; reason: string }) => void = () => {}
    const promise = new Promise<{ readiness: 'READY'; reason: string }>((resolve) => {
      complete = resolve
    })
    const observe = vi.fn(() => promise)
    const args = { db, runId, resolveContext: async () => context, observe }
    const first = observeAntigravityRunReadiness(args)
    const second = observeAntigravityRunReadiness(args)
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce())
    complete({ readiness: 'READY', reason: 'inference_completed' })
    const results = await Promise.all([first, second])
    expect(results[0].receiptId).toBe(results[1].receiptId)
    const evidence = capacityEvidence()
    const agy = evidence.RUN_ROUTING_POSTURE.routes.find(
      (entry) => entry.route_identity === 'antigravity'
    )
    if (!agy) {
      throw new Error('Missing AGY fixture route')
    }
    agy.readiness = 'READY'
    agy.runtime_readiness_receipt_id = 'forged'
    recordRunCapacity(db, runId, evidence)
    expect(
      readRunCapacity(db, runId)?.RUN_ROUTING_POSTURE.routes.find(
        (entry) => entry.route_identity === 'antigravity'
      )
    ).toMatchObject({ readiness: 'UNKNOWN' })
    expect(await observeAntigravityRunReadiness(args)).toMatchObject({
      cacheHit: true,
      receiptId: results[0].receiptId
    })
    expect(observe).toHaveBeenCalledOnce()
    expect(requireAntigravityRunReadiness(db, runId, context)).toBe(context)
  })

  it('does not publish into a changed generation or resurrect a removed handshake', async () => {
    const observe = vi.fn(async () => {
      db.db
        .prepare('UPDATE runs SET consumer_generation = consumer_generation + 1 WHERE id = ?')
        .run(runId)
      return { readiness: 'READY' as const, reason: 'inference_completed' }
    })
    await expect(
      observeAntigravityRunReadiness({ db, runId, resolveContext: async () => context, observe })
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_READY' })
    expect(
      readRunCapacity(db, runId)?.RUN_ROUTING_POSTURE.routes.find(
        (entry) => entry.route_identity === 'antigravity'
      )?.readiness
    ).toBe('UNKNOWN')
    context = { ...context, generation: db.getRunRaw(runId)?.consumer_generation ?? 0 }
    await expect(
      observeAntigravityRunReadiness({
        db,
        runId,
        resolveContext: async () => context,
        observe: async () => {
          db.db.prepare('DELETE FROM run_capacity_handshakes WHERE run_id = ?').run(runId)
          return { readiness: 'READY', reason: 'inference_completed' }
        }
      })
    ).rejects.toMatchObject({ code: 'RUN_CAPACITY_HANDSHAKE_REQUIRED' })
    expect(readRunCapacity(db, runId)).toBeUndefined()
  })
  it('invalidates persisted READY when a new runtime opens the same database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-agy-restart-'))
    const path = join(directory, 'run.sqlite')
    const first = new OrchestrationDb(path)
    const run = first.createRun({
      objective: 'restart',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    recordRunCapacity(first, run.id, capacityEvidence())
    const bound = { ...context, runId: run.id, generation: run.consumer_generation }
    await observeAntigravityRunReadiness({
      db: first,
      runId: run.id,
      resolveContext: async () => bound,
      observe: async () => ({ readiness: 'READY', reason: 'inference_completed' })
    })
    first.close()
    const restarted = new OrchestrationDb(path)
    try {
      expect(
        readRunCapacity(restarted, run.id)?.RUN_ROUTING_POSTURE.routes.find(
          (entry) => entry.route_identity === 'antigravity'
        )
      ).toMatchObject({ readiness: 'UNKNOWN' })
      expect(() => requireAntigravityRunReadiness(restarted, run.id, bound)).toThrowError(
        expect.objectContaining({ code: 'ROUTE_NOT_READY' })
      )
    } finally {
      restarted.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('does not extend the private TTL when wall time moves backward and exposes only public receipt fields', async () => {
    const wall = Date.now()
    const receipt = await observeAntigravityRunReadiness({
      db,
      runId,
      resolveContext: async () => context,
      now: () => wall,
      observe: async () => ({ readiness: 'READY', reason: 'inference_completed' })
    })
    expect(() =>
      requireAntigravityRunReadiness(db, runId, context, wall - 1000000, receipt.monotonicExpiresAt)
    ).toThrowError(expect.objectContaining({ code: 'ROUTE_NOT_READY' }))
    const publicReceipt = publicAntigravityReadinessReceipt(receipt)
    expect(publicReceipt).not.toHaveProperty('contextBinding')
    expect(publicReceipt).not.toHaveProperty('generation')
    expect(publicReceipt).not.toHaveProperty('monotonicExpiresAt')
    expect(publicReceipt).toMatchObject({ readiness: 'READY', model: 'gemini-3.8-flash-high' })
  })
})
