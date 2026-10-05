import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc/methods/orchestration/rpc-test-harness'
import { agentHookServer } from '../../agent-hooks/server'
import { redeemAntigravityCompletion } from '../../agent-hooks/antigravity-completion-capability'
import {
  antigravityCompletionCommand,
  buildAntigravityCompletionPreamble
} from './antigravity-completion-launch'
import { buildDispatchPreamble } from './preamble'

const harness = createOrchestrationRpcHarness()
afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
})
function setup(ready = true) {
  const { runtime, db } = harness.setup()
  const task = db.createTask({ spec: 'AGY completion test' })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'antigravity' }
  })
  const paneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: 'term_worker',
    paneKey,
    processIncarnation: 'runtime_test:term_worker:1',
    worktreeId: 'repo::worktree',
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  if (ready) {
    db.markWorkerDispatchReady(started.dispatch.id)
  }
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  vi.spyOn(agentHookServer, 'buildPtyEnv').mockReturnValue({ ORCA_AGENT_HOOK_PORT: '12345' })
  const command = antigravityCompletionCommand(runtime, started.dispatch.id)
  const token = command.match(/dcap_[A-Za-z0-9_-]+/)?.[0]
  if (!token) {
    throw new Error('missing capability')
  }
  return {
    runtime,
    db,
    taskId: task.id,
    dispatchId: started.dispatch.id,
    token,
    command,
    report: {
      dispatchId: started.dispatch.id,
      runtimeId: runtime.getRuntimeId(),
      outcome: 'succeeded',
      summary: 'AGY_SMOKE_OK'
    }
  }
}

describe('AGY capability uses canonical worker_done settlement', () => {
  it.each([true, false])(
    'settles exactly once, including early pending completion (ready=%s)',
    (ready) => {
      const f = setup(ready)
      redeemAntigravityCompletion(f.token, f.report)
      expect(f.db.getTask(f.taskId)?.status).toBe('completed')
      expect(f.db.getDispatchContextById(f.dispatchId)?.status).toBe('completed')
      expect(f.db.getWorkerDispatch(f.dispatchId)?.state).toBe('succeeded')
      expect(f.runtime.notifyMessageArrived).toHaveBeenCalledWith(expect.any(String), 'worker_done')
      expect(() => redeemAntigravityCompletion(f.token, f.report)).toThrow()
      expect(
        f.db.getUnreadMessages(`run:${f.db.getDispatchContextById(f.dispatchId)?.run_id}`, [
          'worker_done'
        ])
      ).toHaveLength(1)
    }
  )
  it('rejects already settled or replaced runtime identity', () => {
    const f = setup()
    vi.spyOn(f.runtime, 'getRuntimeId').mockReturnValue('restarted_runtime')
    expect(() => redeemAntigravityCompletion(f.token, f.report)).toThrow(
      'completion_worker_inactive'
    )
    expect(f.db.getTask(f.taskId)?.status).toBe('dispatched')
  })
  it('rejects a worker settled through another canonical path', () => {
    const f = setup()
    f.db.settleWorkerReport({
      taskId: f.taskId,
      dispatchId: f.dispatchId,
      outcome: 'succeeded',
      result: 'other completion'
    })
    expect(() => redeemAntigravityCompletion(f.token, f.report)).toThrow(
      'completion_worker_inactive'
    )
    expect(
      f.db.getUnreadMessages(`run:${f.db.getDispatchContextById(f.dispatchId)?.run_id}`, [
        'worker_done'
      ])
    ).toHaveLength(0)
  })
  it('does not falsely acknowledge a canonical refusal', () => {
    const f = setup()
    vi.spyOn(f.db, 'isDispatchProcessCurrent').mockReturnValue(false)
    expect(() => redeemAntigravityCompletion(f.token, f.report)).toThrow()
    expect(f.db.getDispatchContextById(f.dispatchId)?.status).toBe('dispatched')
  })
  it('AGY instructions use only completion capability; non-AGY preamble remains unchanged', () => {
    const f = setup()
    const agy = buildAntigravityCompletionPreamble({
      command: f.command,
      taskSpec: 'Reply AGY_SMOKE_OK'
    })
    expect(agy).toContain('orchestration complete')
    expect(agy).toContain('Do not request sandbox bypass')
    expect(agy).not.toContain('orca-runtime.json')
    const other = buildDispatchPreamble({
      taskId: f.taskId,
      dispatchId: f.dispatchId,
      taskSpec: 'other',
      coordinatorHandle: 'term_coord',
      workerHandle: 'term_worker'
    })
    expect(other).toContain('orchestration send')
    expect(other).not.toContain(f.token)
  })
})
