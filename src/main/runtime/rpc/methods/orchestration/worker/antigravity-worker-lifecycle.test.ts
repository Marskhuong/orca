import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../../../../shared/runtime-types'
import { reconcileRequestedWorkerTerminalReleases } from '../../../../orchestration/worker-terminal-release-reconciliation'
import { observeAntigravityRunReadiness } from '../../../../orchestration/run-capacity-state'
import type { NativeAntigravityReadinessContext } from '../../../../../antigravity/native-readiness-launch-context'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import * as completionLaunch from '../../../../orchestration/antigravity-completion-launch'
import { agentHookServer } from '../../../../../agent-hooks/server'

const READY_WAIT = {
  handle: 'term_worker',
  condition: 'tui-idle',
  satisfied: true,
  status: 'running',
  exitCode: null
} satisfies RuntimeTerminalWait

describe('Antigravity orchestration worker lifecycle', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  async function readyFixture(): Promise<void> {
    h.setup()
    vi.spyOn(agentHookServer, 'buildPtyEnv').mockReturnValue({ ORCA_AGENT_HOOK_PORT: '12345' })
    vi.spyOn(completionLaunch, 'registerAntigravityWorkerStop').mockResolvedValue()
    const context: NativeAntigravityReadinessContext = {
      runId: h.activeRunId,
      generation: h.db.getRunRaw(h.activeRunId)?.consumer_generation ?? 0,
      fingerprint: 'trusted-fixture',
      program: '/audited/agy',
      cwd: '/fixture',
      env: {},
      command: 'agy',
      launchConfig: { agentCommand: 'agy', agentArgs: '', agentEnv: {} }
    }
    vi.spyOn(h.runtime, 'resolveAntigravityReadinessContext').mockResolvedValue(context)
    await observeAntigravityRunReadiness({
      db: h.db,
      runId: h.activeRunId,
      resolveContext: async () => context,
      observe: async () => ({ readiness: 'READY', reason: 'captured_fixture_only' })
    })
  }

  it('owns the terminal immediately and delays prompt delivery until AGY is ready', async () => {
    await readyFixture()
    const readiness = h.deferred<RuntimeTerminalWait>()
    vi.spyOn(h.runtime, 'waitForTerminal').mockReturnValue(readiness.promise)

    const pending = h.startWorker({ agent: 'antigravity', model: 'gemini-3.8-flash-high' })
    await vi.waitFor(() => expect(h.runtime.waitForTerminal).toHaveBeenCalled())

    expect(h.runtime.createTerminal).toHaveBeenCalledWith(
      'id:repo::worktree',
      expect.objectContaining({ startupAgent: 'antigravity', surfaceOwner: false })
    )
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(h.db.listWorkerTerminalResources({})[0]?.resource).toMatchObject({
      ownership_state: 'owned',
      terminal_handle: 'term_worker'
    })

    readiness.resolve(READY_WAIT)
    await expect(pending).resolves.toEqual(
      expect.objectContaining({ dispatchId: expect.any(String) })
    )
    expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
  })

  it('stops only the owned AGY terminal', async () => {
    await readyFixture()
    const { dispatchId } = await h.startWorker({
      agent: 'antigravity',
      model: 'gemini-3.8-flash-high'
    })

    await expect(
      h.call('orchestration.workerStop', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'stopped', processAction: 'closed_agent_terminal' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledOnce()
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
  })

  it('releases an owned AGY terminal and recovers a transient stale endpoint', async () => {
    await readyFixture()
    const { dispatchId } = await h.startSettledWorker('succeeded', {
      agent: 'antigravity',
      model: 'gemini-3.8-flash-high'
    })
    vi.mocked(h.runtime.closeTerminal).mockRejectedValueOnce(new Error('Multiplexer disposed'))

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_pending', processAction: 'none' })
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'releasing'
    })

    await expect(reconcileRequestedWorkerTerminalReleases(h.runtime)).resolves.toMatchObject({
      attempted: 1,
      released: 1
    })
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'released'
    })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(2)
    expect(h.runtime.closeTerminal).toHaveBeenNthCalledWith(2, 'term_worker')
  })

  it('fails closed on a stale AGY handle and releases it on a fresh retry', async () => {
    await readyFixture()
    const { dispatchId } = await h.startSettledWorker('succeeded', {
      agent: 'antigravity',
      model: 'gemini-3.8-flash-high'
    })
    vi.mocked(h.runtime.showTerminal).mockRejectedValueOnce(new Error('terminal_handle_stale'))

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_unknown' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'unknown'
    })

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
  })
})
