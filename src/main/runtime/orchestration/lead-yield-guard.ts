import { z } from 'zod'
import type { OrchestrationDb } from './db'
import type { DispatchCreator } from './db/dispatch-depth'
import type { RunRow } from './types'
import { writeLeadYieldEvidence } from './lead-yield-evidence-write'

export const LEAD_YIELD_GUARD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS lead_yield_expectations (
    dispatch_id TEXT PRIMARY KEY REFERENCES dispatch_contexts(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    consumer_generation INTEGER NOT NULL,
    coordinator_identity TEXT NOT NULL,
    lead_yield_expected INTEGER NOT NULL DEFAULT 1,
    wait_count INTEGER NOT NULL DEFAULT 0,
    poll_count INTEGER NOT NULL DEFAULT 0,
    warned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    wake_delivery_id TEXT,
    cleared_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_lead_yield_run ON lead_yield_expectations(run_id);
  DROP TRIGGER IF EXISTS lead_yield_dispatch_settled;
`

const Expectation = z.object({
  dispatch_id: z.string(),
  run_id: z.string(),
  consumer_generation: z.number(),
  coordinator_identity: z.string(),
  lead_yield_expected: z.number(),
  wait_count: z.number(),
  poll_count: z.number(),
  warned: z.number(),
  wake_delivery_id: z.string().nullable(),
  created_at: z.string(),
  cleared_by: z.string().nullable()
})

export type YieldGuardAction = 'check_wait' | 'worker_poll' | 'worker_action'

export function readLeadYieldGuard(db: OrchestrationDb, runId: string) {
  return z
    .array(Expectation)
    .parse(
      db.db
        .prepare(
          'SELECT * FROM lead_yield_expectations WHERE run_id = ? ORDER BY rowid DESC LIMIT 100'
        )
        .all(runId)
    )
}

function pendingExpectations(db: OrchestrationDb, run: RunRow) {
  return z.array(Expectation).parse(
    db.db
      .prepare(
        `SELECT * FROM lead_yield_expectations WHERE run_id = ?
     AND consumer_generation = ? AND lead_yield_expected = 1 AND wake_delivery_id IS NULL`
      )
      .all(run.id, run.consumer_generation)
  )
}

function audit(
  db: OrchestrationDb,
  run: RunRow,
  dispatchId: string,
  coordinatorIdentity: string,
  action: YieldGuardAction,
  reason?: string
) {
  db.insertMessage({
    runId: run.id,
    from: 'runtime:yield_guard',
    to: `run:${run.id}`,
    type: 'status',
    deliveryContract: 'audit_only',
    subject: reason ? 'PARALLEL_WORK_REASON' : 'LEAD_DID_NOT_YIELD_AFTER_DISPATCH',
    body: reason
      ? 'Independent parallel action declared.'
      : 'Lead continued orchestration before yielding.',
    payload: JSON.stringify({
      runId: run.id,
      coordinatorIdentity,
      dispatchId,
      timestamp: new Date().toISOString(),
      actionCategory: action,
      parallelWorkReasonExisted: reason !== undefined,
      ...(reason ? { PARALLEL_WORK_REASON: reason } : {}),
      rule: 'CANON-R012 yield-by-default'
    })
  })
}

function observeAction(
  db: OrchestrationDb,
  run: RunRow,
  action: YieldGuardAction,
  parallelWorkReason?: string,
  targetDispatchId?: string
): void {
  for (const row of pendingExpectations(db, run)) {
    if (action === 'worker_poll' && row.dispatch_id !== targetDispatchId) {
      continue
    }
    if (parallelWorkReason) {
      audit(db, run, row.dispatch_id, row.coordinator_identity, action, parallelWorkReason)
      continue
    }
    const column = action === 'check_wait' ? 'wait_count' : 'poll_count'
    const count = action === 'check_wait' ? row.wait_count : row.poll_count
    // Two unexempted calls per dispatch; unrelated actions never reset the evidence.
    const violation = action === 'worker_action' || count >= 1
    if (action !== 'worker_action') {
      db.db
        .prepare(`UPDATE lead_yield_expectations SET ${column} = MIN(${column} + 1, 2)
          WHERE dispatch_id = ?`)
        .run(row.dispatch_id)
    }
    if (violation && !row.warned) {
      audit(db, run, row.dispatch_id, row.coordinator_identity, action)
      db.db
        .prepare('UPDATE lead_yield_expectations SET warned = 1 WHERE dispatch_id = ?')
        .run(row.dispatch_id)
    }
  }
}

export function observeLeadYieldAction(
  db: OrchestrationDb,
  run: RunRow,
  action: YieldGuardAction,
  parallelWorkReason?: string,
  targetDispatchId?: string
): void {
  writeLeadYieldEvidence(db.db, () =>
    observeAction(db, run, action, parallelWorkReason, targetDispatchId)
  )
}

function expectYield(
  db: OrchestrationDb,
  dispatchId: string,
  creator: DispatchCreator,
  parallelWorkReason?: string
): void {
  if (creator.kind === 'system') {
    return
  }
  const caller =
    creator.kind === 'session'
      ? {
          address: creator.orcaSessionId,
          orcaSessionId: creator.orcaSessionId,
          terminalHandle: null,
          paneKey: null
        }
      : {
          address: creator.handle,
          orcaSessionId: creator.orcaSessionId ?? null,
          terminalHandle: creator.handle,
          paneKey: creator.paneKey ?? null
        }
  const run = db.getCurrentRunForCoordinator(caller)
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!run || run.legacy || dispatch?.run_id !== run.id || dispatch.creator_dispatch_id) {
    return
  }
  observeAction(db, run, 'worker_action', parallelWorkReason)
  db.db
    .prepare(`INSERT OR IGNORE INTO lead_yield_expectations
    (dispatch_id, run_id, consumer_generation, coordinator_identity, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(
      dispatchId,
      run.id,
      run.consumer_generation,
      caller.orcaSessionId ?? caller.paneKey ?? caller.terminalHandle,
      new Date().toISOString()
    )
}

export function expectLeadYield(
  db: OrchestrationDb,
  dispatchId: string,
  creator: DispatchCreator,
  parallelWorkReason?: string
): void {
  writeLeadYieldEvidence(db.db, () => expectYield(db, dispatchId, creator, parallelWorkReason))
}

export function recordLeadYield(db: OrchestrationDb, run: RunRow): boolean {
  return writeLeadYieldEvidence(db.db, () => {
    db.db
      .prepare(`UPDATE lead_yield_expectations SET lead_yield_expected = 0, cleared_by = 'yield'
    WHERE run_id = ? AND consumer_generation = ? AND lead_yield_expected = 1`)
      .run(run.id, run.consumer_generation)
  })
}

export function isProcessingRunDelivery(db: OrchestrationDb, run: RunRow): boolean {
  return db.hasOutstandingMailboxDelivery(`run:${run.id}`)
}

export function recordLeadYieldWake(
  db: OrchestrationDb,
  run: RunRow,
  deliveryId: string,
  types: readonly string[]
): void {
  if (!types.some((type) => ['worker_done', 'question', 'escalation'].includes(type))) {
    return
  }
  writeLeadYieldEvidence(db.db, () => {
    db.db
      .prepare(`UPDATE lead_yield_expectations SET wake_delivery_id = ?
    WHERE run_id = ? AND consumer_generation = ? AND lead_yield_expected = 1
    AND wake_delivery_id IS NULL`)
      .run(deliveryId, run.id, run.consumer_generation)
  })
}
