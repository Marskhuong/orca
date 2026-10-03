import { OrchestrationDb } from './db'
import { recordRunCapacity } from './run-capacity-state'
import { capacityEvidence } from '../../../shared/orchestration-run-capacity.test-support'
import { federatedStubHomeRunId } from './db/contract-constants'

// Historical lifecycle fixtures assume capacity prerequisites; gate tests use the unseeded DB.
export function createCapacityReadyOrchestrationDb(path: string): OrchestrationDb {
  const db = new OrchestrationDb(path)
  const createRun = db.createRun.bind(db)
  db.createRun = (params) => {
    const run = createRun(params)
    recordRunCapacity(db, run.id, capacityEvidence())
    return run
  }
  const createAttachment = db.createRemoteDispatchAttachment.bind(db)
  db.createRemoteDispatchAttachment = (params) =>
    createAttachment({
      ...params,
      runId: params.runId ?? federatedStubHomeRunId(params.dispatchId),
      capacityEvidence: params.capacityEvidence ?? capacityEvidence()
    })
  function seedExistingRuns(): void {
    for (const run of db.listRuns().runs) {
      if (run.home_database !== 'remote') {
        recordRunCapacity(db, run.id, capacityEvidence())
      }
    }
  }
  const adopt = db.adoptLegacyRunIfNeeded.bind(db)
  db.adoptLegacyRunIfNeeded = () => {
    adopt()
    seedExistingRuns()
  }
  seedExistingRuns()
  return db
}

export function markRunFixtureAsRemote(db: OrchestrationDb, runId: string): void {
  db.db.prepare('DELETE FROM run_capacity_handshakes WHERE run_id = ?').run(runId)
  db.db.prepare("UPDATE runs SET home_database = 'remote' WHERE id = ?").run(runId)
}
