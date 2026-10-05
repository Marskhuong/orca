import {
  parseOrcaSessionAddress,
  formatOrcaSessionAddress
} from '../../../../../../shared/orca-session-address'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { readLeadYieldGuard } from '../../../../orchestration/lead-yield-guard'
import type { OrchestrationRpcState } from '../rpc-test-harness'

describe('Lead yield receipt and Run mailbox boundary', () => {
  const h = createOrchestrationRpcHarness()
  let state: OrchestrationRpcState
  beforeEach(() => {
    state = h.setup()
  })
  afterEach(() => {
    h.cleanup()
    vi.restoreAllMocks()
  })
  const call = (name: string, params: Record<string, unknown>) => h.call(name, params, state.ctx)
  function start() {
    return state.db.createStartingWorkerDispatch({
      taskSpec: 'Disposable RPC fixture',
      taskRunId: state.activeRunId,
      startOptions: {},
      maxDepth: 3,
      creator: { kind: 'terminal', handle: 'term_coord', paneKey: h.coordinatorPaneKey }
    })
  }
  function warnings() {
    return state.db
      .getRunMailboxHistory(state.activeRunId ?? '')
      .filter((message) => message.subject === 'LEAD_DID_NOT_YIELD_AFTER_DISPATCH')
  }

  it('records canonical yield only for the current Run consumer and exposes state', async () => {
    start()
    await expect(
      call('orchestration.yield', { from: 'term_other', run: state.activeRunId })
    ).rejects.toBeDefined()
    expect(readLeadYieldGuard(state.db, state.activeRunId ?? '')[0].lead_yield_expected).toBe(1)
    await expect(call('orchestration.yield', { from: 'term_coord' })).resolves.toMatchObject({
      runId: state.activeRunId,
      yieldGuard: [expect.objectContaining({ lead_yield_expected: 0, cleared_by: 'yield' })]
    })
    await expect(call('orchestration.runShow', { id: state.activeRunId })).resolves.toHaveProperty(
      'yieldGuard'
    )
  })

  it('observes repeated empty waits and preserves the wait result and worker', async () => {
    const started = start()
    vi.spyOn(state.runtime, 'waitForMessage').mockResolvedValue('timed_out')
    const stop = vi.spyOn(state.runtime, 'closeTerminal')
    const before = state.db.getWorkerDispatch(started.dispatch.id)
    for (let index = 0; index < 3; index++) {
      await expect(
        call('orchestration.check', { terminal: 'term_coord', wait: true, timeoutMs: 1 })
      ).resolves.toMatchObject({ timedOut: true })
    }
    expect(warnings()).toHaveLength(1)
    expect(state.db.getWorkerDispatch(started.dispatch.id)).toEqual(before)
    expect(stop).not.toHaveBeenCalled()
    await expect(
      call('orchestration.check', { terminal: 'term_coord', all: true })
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ subject: 'LEAD_DID_NOT_YIELD_AFTER_DISPATCH' })]
    })
  })

  it('counts repeated Worker head reads but exempts cursor pagination and declared parallel reads', async () => {
    const started = start()
    vi.spyOn(state.runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
      terminalHandle: 'term_coord',
      paneKey: h.coordinatorPaneKey,
      processIncarnation: 'fixture',
      launchTokenHash: 'fixture-hash',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const pollingContext = {
      ...state.ctx,
      orchestrationCompatibilityEvidence: { terminalHandle: 'term_coord' }
    }
    const read = (params: Record<string, unknown>) =>
      h.call(
        'orchestration.workerRead',
        { dispatch: started.dispatch.id, ...params },
        pollingContext
      )
    await expect(
      read({ parallelWorkReason: 'Inspect independent fixture diagnostics' })
    ).rejects.toBeDefined()
    await expect(read({ cursor: 'fixture-page-cursor' })).rejects.toBeDefined()
    expect(warnings()).toHaveLength(0)
    await expect(read({})).rejects.toBeDefined()
    expect(warnings()).toHaveLength(0)
    await expect(read({})).rejects.toBeDefined()
    expect(warnings()).toHaveLength(1)
  })

  it.each(['question', 'escalation', 'worker_done'] as const)(
    'delivered %s allows read, reply, ack and checkpoint without warning',
    async (type) => {
      start()
      const message = state.db.insertMessage({
        runId: state.activeRunId,
        from: 'term_worker',
        to: `run:${state.activeRunId}`,
        subject: 'Fixture event',
        type
      })
      const delivered = await call('orchestration.check', { terminal: 'term_coord' })
      expect(delivered).toMatchObject({ count: 1 })
      const parsed =
        typeof delivered === 'object' && delivered !== null && 'deliveryId' in delivered
          ? delivered.deliveryId
          : undefined
      if (typeof parsed !== 'string') {
        throw new Error('No delivery receipt')
      }
      await call('orchestration.reply', {
        from: 'term_coord',
        id: message.id,
        body: 'Fixture answer'
      })
      await call('orchestration.check', { terminal: 'term_coord', ack: parsed })
      await call('orchestration.check', { terminal: 'term_coord' })
      expect(warnings()).toHaveLength(0)
    }
  )

  it('release and status bookkeeping after an immediate settled start do not warn', async () => {
    const started = start()
    state.db.failWorkerStart(started.dispatch.id, 'accepted', 'Fixture refused immediately')
    await call('orchestration.workerRelease', { dispatch: started.dispatch.id })
    await call('orchestration.runShow', { id: state.activeRunId })
    await call('orchestration.check', { terminal: 'term_coord', all: true })
    expect(warnings()).toHaveLength(0)
  })
  it('does not count a wait that receives a heartbeat during blocking', async () => {
    start()
    const waiter = vi.spyOn(state.runtime, 'waitForMessage').mockImplementationOnce(async () => {
      state.db.insertMessage({
        runId: state.activeRunId,
        from: 'term_worker',
        to: `run:${state.activeRunId}`,
        subject: 'alive',
        type: 'heartbeat'
      })
      return 'notified'
    })
    const receipt = await call('orchestration.check', { terminal: 'term_coord', wait: true })
    if (
      typeof receipt !== 'object' ||
      !receipt ||
      !('deliveryId' in receipt) ||
      typeof receipt.deliveryId !== 'string'
    ) {
      throw new Error('Missing heartbeat delivery')
    }
    await call('orchestration.check', { terminal: 'term_coord', ack: receipt.deliveryId })
    waiter.mockResolvedValue('timed_out')
    await call('orchestration.check', { terminal: 'term_coord', wait: true })
    expect(warnings()).toHaveLength(0)
    expect(readLeadYieldGuard(state.db, state.activeRunId ?? '')[0].wait_count).toBe(1)
  })

  it('unattested Worker reads never add evidence against a claimed Lead', async () => {
    const started = start()
    const ctx = {
      ...state.ctx,
      orchestrationCompatibilityEvidence: { terminalHandle: 'term_coord' }
    }
    for (let index = 0; index < 2; index++) {
      await expect(
        h.call('orchestration.workerRead', { dispatch: started.dispatch.id }, ctx)
      ).rejects.toBeDefined()
    }
    expect(warnings()).toHaveLength(0)
    expect(readLeadYieldGuard(state.db, state.activeRunId ?? '')[0].poll_count).toBe(0)
  })
  it('attributes a structured-session Lead through output polling, yield and wake checkpoint', async () => {
    const sessionId = parseOrcaSessionAddress(
      'orca_session_id:4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
    )
    if (!sessionId) {
      throw new Error('Invalid fixture session')
    }
    const address = formatOrcaSessionAddress(sessionId)
    const run = state.db.createRun({
      objective: 'Structured Lead fixture',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: sessionId
    })
    const ctx = {
      ...state.ctx,
      orchestrationCaller: {
        address,
        terminalHandle: null,
        paneKey: null,
        orcaSessionId: sessionId,
        sessionId,
        workspaceId: 'worktree_fixture'
      }
    }
    const makeWorker = () =>
      state.db.createStartingWorkerDispatch({
        taskSpec: 'Fixture work',
        taskRunId: run.id,
        startOptions: {},
        maxDepth: 3,
        creator: { kind: 'session', orcaSessionId: sessionId }
      })
    const started = makeWorker()
    for (let index = 0; index < 2; index++) {
      await expect(
        h.call('orchestration.workerRead', { dispatch: started.dispatch.id }, ctx)
      ).rejects.toBeDefined()
    }
    expect(readLeadYieldGuard(state.db, run.id)[0]).toMatchObject({
      coordinator_identity: sessionId,
      poll_count: 2,
      warned: 1
    })
    await expect(
      h.call('orchestration.yield', { from: address, run: run.id }, ctx)
    ).resolves.toMatchObject({ yieldRecorded: true })
    const next = makeWorker()
    state.db.insertMessage({
      runId: run.id,
      from: 'fixture_worker',
      to: `run:${run.id}`,
      subject: 'Fixture question',
      type: 'question'
    })
    await h.call('orchestration.check', { run: run.id }, ctx)
    expect(
      readLeadYieldGuard(state.db, run.id).find((row) => row.dispatch_id === next.dispatch.id)
        ?.wake_delivery_id
    ).toBeTypeOf('string')
  })
})
