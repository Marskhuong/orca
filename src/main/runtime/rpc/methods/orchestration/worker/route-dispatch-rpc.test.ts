import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { eraseRpcMethods, type RpcContext, type RpcMethodDeclaration } from '../../../core'
import { AGENT_LAUNCH_METHODS } from '../../agent-launch'
import { WORKTREE_METHODS } from '../../worktree'
import { TERMINAL_LIFECYCLE_METHODS } from '../../terminal/terminal-lifecycle-methods'
import { assertNotGovernedAgentLaunch } from '../../../governed-agent-launch-fence'
import * as workerTopology from './worker-topology'

function dispatchIdOf(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    'dispatchId' in value &&
    typeof value.dispatchId === 'string'
  ) {
    return value.dispatchId
  }
  throw new Error('worker-start returned no dispatchId')
}

function routeEvidence(routes: Record<string, unknown>[]) {
  return {
    RUN_CAPACITY_SNAPSHOT_ID: 'snap-route',
    RUN_ROUTING_POSTURE: {
      RUN_CAPACITY_SNAPSHOT_ID: 'snap-route',
      capacity_observation_status: 'FRESH',
      routes: routes.map((route) => ({
        availability: 'AVAILABLE',
        availability_source: 'CAPACITY_SNAPSHOT',
        reserve: 'NONE',
        capacity_observation: 'OBSERVED',
        snapshot_id: 'snap-route',
        ...route
      }))
    }
  }
}

describe('governed route dispatch and agent-launch fence', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => h.setup())
  afterEach(() => h.cleanup())

  async function record(routes: Record<string, unknown>[]): Promise<void> {
    await h.call('orchestration.runCapacityRecord', {
      id: h.activeRunId,
      from: 'term_coord',
      evidence: routeEvidence(routes)
    })
  }

  function expectNoWorkerEffects(): void {
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(h.db.listTasks({ runId: h.activeRunId })).toEqual([])
  }

  it('refuses AVAILABLE + NOT_READY before any Task, worktree, session, or terminal', async () => {
    await record([
      {
        route_identity: 'deepseek',
        readiness: 'NOT_READY',
        readiness_reason: 'provider path unusable'
      },
      { route_identity: 'codex', readiness: 'READY' }
    ])
    const worktree = vi.spyOn(h.runtime, 'createManagedWorktree')
    const session = vi.spyOn(workerTopology, 'createStructuredWorkerSessionForWorktree')
    const remote = vi.spyOn(h.runtime, 'callOrchestrationWorkerServer')
    await expect(
      h.call('orchestration.workerStart', {
        from: 'term_coord',
        spec: 'review',
        agent: 'opencode',
        route: 'deepseek'
      })
    ).rejects.toMatchObject({
      code: 'ROUTE_NOT_READY',
      data: {
        route: 'deepseek',
        readiness: 'NOT_READY',
        readinessReason: 'provider path unusable',
        availability: 'AVAILABLE',
        effectsApplied: false,
        workerCreated: false,
        routeSelectedByRuntime: false
      }
    })
    expectNoWorkerEffects()
    expect(worktree).not.toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
    expect(remote).not.toHaveBeenCalled()
  })

  it('lets the coordinator choose the next READY route after a readiness refusal', async () => {
    await record([
      { route_identity: 'deepseek', readiness: 'NOT_READY' },
      { route_identity: 'codex', readiness: 'READY' }
    ])
    const task = h.db.createTask({ runId: h.activeRunId, spec: 'implementation' })
    await expect(
      h.call('orchestration.workerStart', {
        from: 'term_coord',
        task: task.id,
        route: 'deepseek',
        agent: 'opencode'
      })
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_READY' })
    expect(h.db.getTask(task.id)?.status).toBe('ready')
    const dispatchId = dispatchIdOf(
      await h.call('orchestration.workerStart', {
        from: 'term_coord',
        task: task.id,
        route: 'codex',
        agent: 'codex'
      })
    )
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(JSON.parse(h.db.getWorkerDispatch(dispatchId)!.start_options)).toMatchObject({
      agent: 'codex'
    })
  })

  it('blocks omitted Antigravity at readiness with zero worker effects', async () => {
    await record([
      { route_identity: 'claude', readiness: 'READY' },
      { route_identity: 'codex', readiness: 'READY' },
      { route_identity: 'deepseek', readiness: 'READY' }
    ])
    await expect(
      h.call('orchestration.workerStart', {
        from: 'term_coord',
        spec: 'manual AGY',
        agent: 'antigravity'
      })
    ).rejects.toMatchObject({
      code: 'ROUTE_NOT_READY',
      data: {
        route: 'antigravity',
        readiness: 'UNKNOWN',
        effectsApplied: false,
        workerCreated: false
      }
    })
    expectNoWorkerEffects()
  })
  it('refuses caller READY Antigravity without runtime authority even with capacity UNKNOWN', async () => {
    await record([
      {
        route_identity: 'antigravity',
        availability: 'UNKNOWN',
        availability_source: 'NONE',
        readiness: 'READY',
        readiness_reason: 'Bounded readiness evidence'
      }
    ])
    await expect(
      h.call('orchestration.workerStart', {
        from: 'term_coord',
        spec: 'manual AGY',
        agent: 'antigravity',
        model: 'gemini-3.8-flash-high'
      })
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_READY' })
    expectNoWorkerEffects()
  })
  it.each([
    { route: 'qwen', agent: 'opencode' },
    { agent: 'qwen-code' },
    { agent: 'claude', model: 'qwen3-coder-next' }
  ])('refuses retired Qwen dispatch %j even when the posture lists it READY', async (params) => {
    await record([
      { route_identity: 'qwen', readiness: 'READY' },
      { route_identity: 'deepseek', readiness: 'READY' }
    ])
    await expect(
      h.call('orchestration.workerStart', { from: 'term_coord', spec: 'routine', ...params })
    ).rejects.toMatchObject({
      code: 'ROUTE_RETIRED_BY_POLICY',
      data: { effectsApplied: false, workerCreated: false, routeSelectedByRuntime: false }
    })
    expectNoWorkerEffects()
  })

  it('refuses an unattributed dispatch once the posture records readiness', async () => {
    await record([{ route_identity: 'deepseek', readiness: 'READY' }])
    await expect(
      h.call('orchestration.workerStart', { from: 'term_coord', spec: 'review', agent: 'opencode' })
    ).rejects.toMatchObject({ code: 'ROUTE_IDENTITY_REQUIRED' })
    expectNoWorkerEffects()
  })

  describe('existing agent terminals', () => {
    function terminalRuns(agentIdentity: string): void {
      vi.mocked(h.runtime.showTerminal).mockImplementation(
        async (handle) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only agentIdentity is read by the route check.
          ({ handle, worktreeId: 'repo::worktree', status: 'running', agentIdentity }) as never
      )
    }

    it.each([true, false])(
      'refuses manual dispatch (inject=%s) to a retired agent terminal before any Dispatch',
      async (inject) => {
        terminalRuns('qwen-code')
        const task = h.db.createTask({ runId: h.activeRunId, spec: 'routine' })
        await expect(
          h.call('orchestration.dispatch', {
            task: task.id,
            from: 'term_coord',
            to: 'term_worker',
            inject
          })
        ).rejects.toMatchObject({
          code: 'ROUTE_RETIRED_BY_POLICY',
          data: { effectsApplied: false, workerCreated: false }
        })
        expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
        expect(h.db.getDispatchContext(task.id)).toBeUndefined()
        expect(h.db.getTask(task.id)?.status).toBe('ready')
      }
    )

    it('refuses worker-start reuse of a retired agent terminal', async () => {
      terminalRuns('qwen-code')
      await expect(
        h.call('orchestration.workerStart', {
          from: 'term_coord',
          spec: 'routine',
          terminal: 'term_worker'
        })
      ).rejects.toMatchObject({ code: 'ROUTE_RETIRED_BY_POLICY' })
      expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      expect(h.db.listTasks({ runId: h.activeRunId })).toEqual([])
    })

    it('checks a manual dispatch route against recorded readiness', async () => {
      terminalRuns('opencode')
      await record([
        { route_identity: 'deepseek', readiness: 'NOT_READY' },
        { route_identity: 'codex', readiness: 'READY' }
      ])
      const task = h.db.createTask({ runId: h.activeRunId, spec: 'review' })
      await expect(
        h.call('orchestration.dispatch', {
          task: task.id,
          from: 'term_coord',
          to: 'term_worker',
          route: 'deepseek'
        })
      ).rejects.toMatchObject({ code: 'ROUTE_NOT_READY' })
      await expect(
        h.call('orchestration.dispatch', { task: task.id, from: 'term_coord', to: 'term_worker' })
      ).rejects.toMatchObject({ code: 'ROUTE_IDENTITY_REQUIRED' })
      expect(h.db.getDispatchContext(task.id)).toBeUndefined()
    })
  })

  it('still requires the capacity handshake before evaluating the route', async () => {
    h.db.db.prepare('DELETE FROM run_capacity_handshakes').run()
    await expect(
      h.call('orchestration.workerStart', {
        from: 'term_coord',
        spec: 'x',
        agent: 'codex',
        route: 'codex'
      })
    ).rejects.toMatchObject({ code: 'RUN_CAPACITY_HANDSHAKE_REQUIRED' })
    expectNoWorkerEffects()
  })

  describe('agent-launch surfaces', () => {
    function method(list: readonly RpcMethodDeclaration[], name: string) {
      const found = eraseRpcMethods(list).find((m) => m.name === name)
      if (!found) {
        throw new Error(`missing ${name}`)
      }
      return found
    }
    const coordinatorEvidence = (): RpcContext => ({
      runtime: h.runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_coord',
        paneKey: h.coordinatorPaneKey
      }
    })

    it.each([
      [
        'agent.launch',
        AGENT_LAUNCH_METHODS,
        {
          agent: 'opencode',
          target: { kind: 'existing', worktree: 'repo::wt' },
          prompt: { text: 'review', delivery: 'submit' }
        }
      ],
      [
        'agent.launchReplay',
        AGENT_LAUNCH_METHODS,
        {
          agent: 'claude',
          operationId: `${Date.now()}-${'a'.repeat(32)}`,
          target: { kind: 'existing', worktree: 'repo::wt' }
        }
      ],
      [
        'worktree.create',
        WORKTREE_METHODS,
        { repo: 'repo', startupAgent: 'codex', startupPrompt: 'implement' }
      ],
      [
        'terminal.create',
        TERMINAL_LIFECYCLE_METHODS,
        {
          worktree: 'repo::wt',
          launchAgent: 'claude',
          launchConfig: { agentArgs: '', agentEnv: {} }
        }
      ]
    ])(
      'refuses %s from a Run coordinator without creating anything',
      async (name, list, params) => {
        const m = method(list, name)
        const parsed = m.params!.parse(params)
        const worktree = vi.spyOn(h.runtime, 'createManagedWorktree')
        const dedupeWorktree = vi.spyOn(h.runtime, 'dedupeWorktreeCreate')
        const dedupeTerminal = vi.spyOn(h.runtime, 'dedupeTerminalCreate')
        await expect(m.handler(parsed, coordinatorEvidence())).rejects.toMatchObject({
          code: 'GOVERNED_DISPATCH_REQUIRED',
          data: {
            runId: h.activeRunId,
            role: 'coordinator',
            effectsApplied: false,
            workerCreated: false
          }
        })
        expect(worktree).not.toHaveBeenCalled()
        expect(dedupeWorktree).not.toHaveBeenCalled()
        expect(dedupeTerminal).not.toHaveBeenCalled()
        expect(h.runtime.createTerminal).not.toHaveBeenCalled()
      }
    )

    it('refuses an agent launch from an active worker of the Run', async () => {
      const worker = await h.startWorker()
      expect(() =>
        assertNotGovernedAgentLaunch(
          {
            runtime: h.runtime,
            orchestrationCompatibilityEvidence: {
              terminalHandle: 'term_worker',
              paneKey: h.workerPaneKey
            }
          },
          'agent.launch'
        )
      ).toThrow(expect.objectContaining({ code: 'GOVERNED_DISPATCH_REQUIRED' }))
      expect(h.db.getWorkerDispatch(worker.dispatchId)?.state).toBe('ready')
    })

    it('resolves the coordinator from its live pane when the caller declares only a handle', () => {
      expect(() =>
        assertNotGovernedAgentLaunch(
          {
            runtime: h.runtime,
            orchestrationCompatibilityEvidence: { terminalHandle: 'term_coord' }
          },
          'worktree.create with a startup agent'
        )
      ).toThrow(expect.objectContaining({ code: 'GOVERNED_DISPATCH_REQUIRED' }))
    })

    it('leaves human, UI, and unrelated-terminal launches alone', () => {
      expect(() =>
        assertNotGovernedAgentLaunch({ runtime: h.runtime }, 'agent.launch')
      ).not.toThrow()
      expect(() =>
        assertNotGovernedAgentLaunch(
          {
            runtime: h.runtime,
            orchestrationCompatibilityEvidence: { terminalHandle: 'term_human' }
          },
          'agent.launch'
        )
      ).not.toThrow()
    })

    it('does not fence a plain shell terminal or a worktree without a startup agent', async () => {
      const dedupeTerminal = vi
        .spyOn(h.runtime, 'dedupeTerminalCreate')
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only forwards this mocked receipt; its shape is not under test.
        .mockResolvedValue({ handle: 'term_shell' } as never)
      const terminal = method(TERMINAL_LIFECYCLE_METHODS, 'terminal.create')
      await terminal.handler(
        terminal.params!.parse({ worktree: 'repo::wt', command: 'pnpm test' }),
        coordinatorEvidence()
      )
      expect(dedupeTerminal).toHaveBeenCalledTimes(1)
      const dedupeWorktree = vi
        .spyOn(h.runtime, 'dedupeWorktreeCreate')
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only forwards this mocked receipt; its shape is not under test.
        .mockResolvedValue({ worktree: { id: 'wt' } } as never)
      const worktree = method(WORKTREE_METHODS, 'worktree.create')
      await worktree.handler(worktree.params!.parse({ repo: 'repo' }), coordinatorEvidence())
      expect(dedupeWorktree).toHaveBeenCalledTimes(1)
    })
  })
})
