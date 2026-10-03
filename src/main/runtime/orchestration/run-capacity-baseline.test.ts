import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())

it('refuses a starting worker before persisting its inline Task when the Run has no handshake', () => {
  db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'capacity regression',
    coordinatorHandle: 'term_lead',
    coordinatorPaneKey: 'tab_lead:leaf_lead'
  })
  const start = () =>
    db!.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 2,
      taskRunId: run.id,
      taskSpec: 'substantive audit',
      startOptions: { agent: 'codex' }
    })
  expect(start).toThrowError(expect.objectContaining({ code: 'RUN_CAPACITY_HANDSHAKE_REQUIRED' }))
  expect(db.listTasks({ runId: run.id })).toEqual([])
})
