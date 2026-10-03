import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { readRunCapacity, recordRunCapacity } from './run-capacity-state'
import { capacityEvidence } from '../../../shared/orchestration-run-capacity.test-support'

it('retains the handshake after reopening and clears it with its Run on reset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-run-capacity-'))
  const dbPath = join(directory, 'orchestration.db')
  let db = new OrchestrationDb(dbPath)
  try {
    const run = db.createRun({
      objective: 'persist capacity',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    recordRunCapacity(db, run.id, capacityEvidence())
    db.close()
    db = new OrchestrationDb(dbPath)
    expect(readRunCapacity(db, run.id)).toEqual(capacityEvidence())
    expect(
      db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 2,
        taskRunId: run.id,
        taskSpec: 'after restart',
        startOptions: {}
      }).worker.state
    ).toBe('starting')
    db.resetAll()
    expect(readRunCapacity(db, run.id)).toBeUndefined()
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
