import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Coordinator } from './coordinator'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import { OrchestrationDb } from './db'
import { recordRunCapacity } from './run-capacity-state'
import { capacityEvidence } from '../../../shared/orchestration-run-capacity.test-support'

describe('capacity gate before automatic terminal allocation', () => {
  let db: OrchestrationDb
  let coordinator: Coordinator | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => {
    coordinator?.stop()
    db.close()
    vi.useRealTimers()
  })
  function createRuntime(): CoordinatorRuntime {
    return {
      listTerminals: vi.fn(async () => ({ terminals: [] })),
      createTerminal: vi.fn(async () => ({ handle: 'worker', worktreeId: 'folder-workspace' })),
      sendTerminalAgentPrompt: vi.fn(async () => ({ accepted: true })),
      waitForTerminal: async (handle) => ({ handle, condition: 'exit' }),
      probeWorktreeDrift: async () => null
    }
  }
  async function tick(runtime: CoordinatorRuntime) {
    coordinator = new Coordinator(db, runtime, {
      coordinatorHandle: 'lead',
      spec: 'supervise Tasks',
      pollIntervalMs: 1000,
      maxConcurrent: 1,
      onLog: () => {}
    })
    const running = coordinator.run()
    await vi.advanceTimersByTimeAsync(1000)
    coordinator.stop()
    await vi.advanceTimersByTimeAsync(1000)
    await running
  }
  it('creates no terminal or dispatch when capacity is absent', async () => {
    db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const runtime = createRuntime()
    await tick(runtime)
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
  it('does not let an unregistered Run starve an eligible Run', async () => {
    const a = db.createRun({
      objective: 'authorized',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const b = db.createRun({
      objective: 'unregistered',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const blocked = db.createTask({ runId: b.id, spec: 'blocked' })
    const eligible = db.createTask({ runId: a.id, spec: 'eligible' })
    recordRunCapacity(db, a.id, capacityEvidence())
    const runtime = createRuntime()
    await tick(runtime)
    expect(runtime.createTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
    expect(db.getDispatchContext(eligible.id)).toBeDefined()
    expect(db.getDispatchContext(blocked.id)).toBeUndefined()
    expect(db.getTask(blocked.id)?.status).toBe('ready')
  })
  it('rechecks capacity after an asynchronous terminal census before creating resources', async () => {
    recordRunCapacity(db, 'run_legacy_local', capacityEvidence())
    db.createTask({ runId: 'run_legacy_local', spec: 'deferred census' })
    const runtime = createRuntime()
    vi.mocked(runtime.listTerminals).mockImplementation(async () => {
      db.db.prepare('DELETE FROM run_capacity_handshakes').run()
      return { terminals: [] }
    })
    await tick(runtime)
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
