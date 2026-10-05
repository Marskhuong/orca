import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCapacityReadyOrchestrationDb } from './capacity-ready-db.test-support'
import {
  observeLeadYieldAction,
  readLeadYieldGuard,
  recordLeadYield,
  recordLeadYieldWake
} from './lead-yield-guard'
import { ParallelWorkReason } from '../../../shared/orchestration-lead-yield'
import type { OrchestrationDb } from './db'

const pane = 'tab_lead:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const opened: OrchestrationDb[] = []
function fixture(path = ':memory:') {
  const db = createCapacityReadyOrchestrationDb(path)
  opened.push(db)
  const run = db.createRun({
    objective: 'Disposable Yield Guard fixture',
    coordinatorHandle: 'lead',
    coordinatorPaneKey: pane
  })
  const start = (reason?: string) =>
    db.createStartingWorkerDispatch({
      taskSpec: 'Trivial worker fixture',
      taskRunId: run.id,
      startOptions: {},
      creator: { kind: 'terminal', handle: 'lead', paneKey: pane },
      maxDepth: 3,
      parallelWorkReason: reason
    })
  const warnings = () =>
    db
      .getRunMailboxHistory(run.id)
      .filter((message) => message.subject === 'LEAD_DID_NOT_YIELD_AFTER_DISPATCH')
  return { db, run, start, warnings }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of opened.splice(0)) {
    db.close()
  }
})

describe('Lead Yield Guard V1 observability', () => {
  it('records substantive Lead dispatch atomically, and canonical yield clears it', () => {
    const f = fixture()
    const started = f.start()
    expect(readLeadYieldGuard(f.db, f.run.id)).toEqual([
      expect.objectContaining({ dispatch_id: started.dispatch.id, lead_yield_expected: 1 })
    ])
    recordLeadYield(f.db, f.run)
    observeLeadYieldAction(f.db, f.run, 'worker_action')
    expect(readLeadYieldGuard(f.db, f.run.id)[0]).toMatchObject({
      lead_yield_expected: 0,
      cleared_by: 'yield'
    })
    expect(f.warnings()).toHaveLength(0)
  })

  it.each(['check_wait', 'worker_poll'] as const)(
    'warns on the second %s, once per dispatch',
    (action) => {
      const f = fixture()
      const started = f.start()
      const workerBefore = f.db.getWorkerDispatch(started.dispatch.id)
      observeLeadYieldAction(f.db, f.run, action, undefined, started.dispatch.id)
      expect(f.warnings()).toHaveLength(0)
      observeLeadYieldAction(f.db, f.run, action, undefined, started.dispatch.id)
      observeLeadYieldAction(f.db, f.run, action, undefined, started.dispatch.id)
      observeLeadYieldAction(f.db, f.run, 'worker_action')
      expect(f.warnings()).toHaveLength(1)
      const warning = f.warnings()[0]
      expect(warning.delivery_contract).toBe('audit_only')
      expect(JSON.parse(warning.payload ?? '{}')).toMatchObject({
        runId: f.run.id,
        coordinatorIdentity: pane,
        dispatchId: started.dispatch.id,
        actionCategory: action,
        parallelWorkReasonExisted: false,
        rule: 'CANON-R012 yield-by-default'
      })
      expect(f.db.getUnreadRunMailbox(f.run.id)).toHaveLength(0)
      expect(f.db.getWorkerDispatch(started.dispatch.id)).toEqual(workerBefore)
      expect(f.db.getTask(started.task.id)?.status).toBe(started.task.status)
      expect(f.db.getDispatchContextById(started.dispatch.id)?.status).toBe('pending')
    }
  )

  it('warns on additional substantive actions, without preventing their dispatch', () => {
    const f = fixture()
    f.start()
    const second = f.start()
    expect(f.db.getWorkerDispatch(second.dispatch.id)?.state).toBe('starting')
    expect(f.warnings()).toHaveLength(1)
    expect(readLeadYieldGuard(f.db, f.run.id)).toHaveLength(2)
  })

  it('limits parallel evidence to the declared action, preserving later detection', () => {
    const f = fixture()
    f.start()
    observeLeadYieldAction(f.db, f.run, 'worker_action', 'Check independent fixture formatting')
    expect(f.warnings()).toHaveLength(0)
    expect(f.db.getRunMailboxHistory(f.run.id)[0].subject).toBe('PARALLEL_WORK_REASON')
    observeLeadYieldAction(f.db, f.run, 'worker_action')
    expect(f.warnings()).toHaveLength(1)
    expect(readLeadYieldGuard(f.db, f.run.id)[0].lead_yield_expected).toBe(1)
    expect(ParallelWorkReason.safeParse('   ').success).toBe(false)
    expect(ParallelWorkReason.safeParse('x'.repeat(241)).success).toBe(false)
  })

  it.each(['worker_done', 'question', 'escalation'])(
    'permits the %s wake checkpoint and arms a new dispatch independently',
    (type) => {
      const f = fixture()
      f.start()
      recordLeadYieldWake(f.db, f.run, 'del_wake', [type])
      observeLeadYieldAction(f.db, f.run, 'worker_action')
      observeLeadYieldAction(f.db, f.run, 'check_wait')
      observeLeadYieldAction(f.db, f.run, 'check_wait')
      expect(f.warnings()).toHaveLength(0)
      const next = f.start()
      observeLeadYieldAction(f.db, f.run, 'worker_poll', undefined, next.dispatch.id)
      observeLeadYieldAction(f.db, f.run, 'worker_poll', undefined, next.dispatch.id)
      expect(f.warnings()).toHaveLength(1)
    }
  )

  it('clears immediately settled dispatches without reinterpreting UNKNOWN', () => {
    const f = fixture()
    const failed = f.start()
    f.db.failWorkerStart(failed.dispatch.id, 'accepted', 'Fixture immediate refusal')
    expect(readLeadYieldGuard(f.db, f.run.id)[0]).toMatchObject({
      lead_yield_expected: 0,
      cleared_by: 'settled'
    })
    const unknown = f.start()
    f.db.markWorkerStartUnknown(unknown.dispatch.id, 'accepted', 'Fixture ambiguous delivery')
    const worker = f.db.getWorkerDispatch(unknown.dispatch.id)
    observeLeadYieldAction(f.db, f.run, 'worker_poll', undefined, unknown.dispatch.id)
    observeLeadYieldAction(f.db, f.run, 'worker_poll', undefined, unknown.dispatch.id)
    expect(f.db.getWorkerDispatch(unknown.dispatch.id)).toEqual(worker)
    expect(worker?.state).toBe('start_unknown')
    expect(f.db.getDispatchContextById(unknown.dispatch.id)?.status).toBe('pending')
  })

  it('does not backfill historical runs or attribute system bookkeeping to Lead', () => {
    const f = fixture()
    observeLeadYieldAction(f.db, f.run, 'check_wait')
    observeLeadYieldAction(f.db, f.run, 'worker_action')
    f.db.createStartingWorkerDispatch({
      taskSpec: 'System fixture',
      taskRunId: f.run.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 3
    })
    expect(readLeadYieldGuard(f.db, f.run.id)).toHaveLength(0)
    expect(f.warnings()).toHaveLength(0)
  })

  it('preserves counters and warning deduplication across runtime restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-yield-guard-'))
    try {
      const path = join(directory, 'orchestration.db')
      const f = fixture(path)
      f.start()
      observeLeadYieldAction(f.db, f.run, 'check_wait')
      f.db.close()
      opened.splice(opened.indexOf(f.db), 1)
      const reopened = createCapacityReadyOrchestrationDb(path)
      opened.push(reopened)
      observeLeadYieldAction(reopened, f.run, 'check_wait')
      observeLeadYieldAction(reopened, f.run, 'check_wait')
      expect(
        reopened
          .getRunMailboxHistory(f.run.id)
          .filter((message) => message.subject === 'LEAD_DID_NOT_YIELD_AFTER_DISPATCH')
      ).toHaveLength(1)
      reopened.close()
      opened.splice(opened.indexOf(reopened), 1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('keeps head-read counters on their target Worker, avoiding fan-in warnings', () => {
    const f = fixture()
    const first = f.start()
    const second = f.start('Independent second worker')
    observeLeadYieldAction(f.db, f.run, 'worker_poll', undefined, first.dispatch.id)
    observeLeadYieldAction(f.db, f.run, 'worker_poll', undefined, second.dispatch.id)
    expect(f.warnings()).toHaveLength(0)
    observeLeadYieldAction(f.db, f.run, 'worker_poll', undefined, first.dispatch.id)
    expect(f.warnings()).toHaveLength(1)
    expect(JSON.parse(f.warnings()[0].payload ?? '{}').dispatchId).toBe(first.dispatch.id)
  })

  it('isolates an audit-write failure from accepted dispatch state and rolls back guard evidence', () => {
    const f = fixture()
    const first = f.start()
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(f.db, 'insertMessage').mockImplementation(() => {
      throw new Error('private fixture diagnostic')
    })
    const second = f.start()
    expect(f.db.getWorkerDispatch(second.dispatch.id)?.state).toBe('starting')
    expect(f.db.getDispatchContextById(second.dispatch.id)?.status).toBe('pending')
    expect(readLeadYieldGuard(f.db, f.run.id)).toEqual([
      expect.objectContaining({ dispatch_id: first.dispatch.id, warned: 0 })
    ])
    expect(log).toHaveBeenCalledWith(
      'Yield Guard evidence unavailable; lifecycle execution continues.'
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('private fixture diagnostic')
  })

  it('settles a Worker even if its optional guard table is unavailable', () => {
    const f = fixture()
    const started = f.start()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.db.db.exec('DROP TABLE lead_yield_expectations')
    f.db.failWorkerStart(started.dispatch.id, 'accepted', 'Fixture definite refusal')
    expect(f.db.getWorkerDispatch(started.dispatch.id)?.state).toBe('failed')
    expect(f.db.getDispatchContextById(started.dispatch.id)?.status).toBe('failed')
  })
})
