import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../../src/main/runtime/rpc/methods/orchestration'
import { createOrchestrationWorkerReleaseHarness } from '../../src/main/runtime/rpc/methods/orchestration/worker/worker-release.test-support'
import { capacityEvidence } from '../../src/shared/orchestration-run-capacity.test-support'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../src/shared/protocol-version'
import { RuntimeRpcFailureError } from '../../src/cli/runtime/types'
import { main } from '../../src/cli/index'

const call = vi.hoisted(() => vi.fn())
vi.mock('../../src/cli/runtime-client', async (importOriginal) => ({
  ...(await importOriginal()),
  RuntimeClient: class {
    call = call
  }
}))

const h = createOrchestrationWorkerReleaseHarness()
let sequence = 0
let originalExitCode

beforeEach(() => {
  originalExitCode = process.exitCode
  h.setup()
  h.db.db.prepare('DELETE FROM run_capacity_handshakes').run()
  sequence = 0
  const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: ORCHESTRATION_METHODS })
  call.mockReset().mockImplementation(async (method, params) => {
    const id = `capacity-cli-${++sequence}`
    const response = await dispatcher.dispatch({
      id,
      authToken: 'test-token',
      method,
      params,
      orchestrationRequestId: id,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    })
    if (!response.ok) {
      throw new RuntimeRpcFailureError(response)
    }
    return response
  })
})

afterEach(() => {
  h.cleanup()
  vi.restoreAllMocks()
  process.exitCode = originalExitCode
})

it('source CLI registers UNKNOWN evidence and unlocks dispatch only after the handshake', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const invoke = async (command, args = []) => {
    output.mockClear()
    process.exitCode = 0
    await main(['orchestration', command, ...args, '--json'], tmpdir())
    expect(output).toHaveBeenCalledTimes(1)
    const response = JSON.parse(output.mock.calls[0][0])
    return response
  }
  const idArgs = ['--id', h.activeRunId]
  expect(await invoke('run-show', idArgs)).toMatchObject({
    ok: true,
    result: { run: { id: h.activeRunId } }
  })
  expect(await invoke('run-capacity-show', idArgs)).toMatchObject({
    ok: true,
    result: { recorded: false }
  })
  expect(call).toHaveBeenLastCalledWith('orchestration.runCapacityShow', { id: h.activeRunId })
  const workerArgs = ['--from', 'term_coord', '--spec', 'disposable audit', '--agent', 'codex']
  expect(await invoke('worker-start', workerArgs)).toMatchObject({
    ok: false,
    error: {
      code: 'RUN_CAPACITY_HANDSHAKE_REQUIRED',
      data: { effectsApplied: false, workerCreated: false }
    }
  })
  expect(process.exitCode).toBe(1)
  expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  expect(h.db.listTasks({ runId: h.activeRunId })).toEqual([])
  const evidence = capacityEvidence('UNKNOWN')
  expect(
    await invoke('run-capacity-record', [
      ...idArgs,
      '--from',
      'term_coord',
      '--evidence',
      JSON.stringify(evidence)
    ])
  ).toMatchObject({ ok: true, result: { recorded: true, ...evidence } })
  expect(call).toHaveBeenLastCalledWith('orchestration.runCapacityRecord', {
    id: h.activeRunId,
    from: 'term_coord',
    evidence
  })
  expect(await invoke('run-capacity-show', idArgs)).toMatchObject({
    ok: true,
    result: { recorded: true, ...evidence }
  })
  expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  expect(h.db.listTasks({ runId: h.activeRunId })).toEqual([])
  expect(await invoke('worker-start', workerArgs)).toMatchObject({
    ok: true,
    result: { state: 'ready', dispatchId: expect.any(String) }
  })
  expect(process.exitCode).toBe(0)
  expect(h.runtime.createTerminal).toHaveBeenCalledTimes(1)
})

it.each(['run-capacity-record', 'run-capacity-show'])(
  'rejects a missing Run through %s',
  async (command) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'orchestration',
        command,
        '--id',
        'run_missing',
        ...(command === 'run-capacity-record'
          ? ['--from', 'term_coord', '--evidence', JSON.stringify(capacityEvidence())]
          : []),
        '--json'
      ],
      tmpdir()
    )
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ ok: false })
    expect(process.exitCode).toBe(1)
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  }
)

it('propagates coordinator refusal without recording evidence', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  await main(
    [
      'orchestration',
      'run-capacity-record',
      '--id',
      h.activeRunId,
      '--from',
      'term_worker',
      '--evidence',
      JSON.stringify(capacityEvidence()),
      '--json'
    ],
    tmpdir()
  )
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ ok: false })
  expect(process.exitCode).toBe(1)
  expect(h.db.db.prepare('SELECT * FROM run_capacity_handshakes').all()).toEqual([])
  expect(h.runtime.createTerminal).not.toHaveBeenCalled()
})
