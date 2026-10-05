import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_RUN_HANDLERS } from './orchestration/run-handlers'
import { parallelWorkEvidence } from './orchestration/lead-yield-evidence'
import { LEAD_YIELD_RUNTIME_CAPABILITY } from '../../shared/orchestration-lead-yield'

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('./orchestration/terminal-identity', () => ({
  resolveCoordinatorTerminalHandle: async () => 'term_lead'
}))

describe('Lead yield CLI evidence', () => {
  const client = new RuntimeClient('/tmp/yield-guard-cli-fixture')
  const call = vi.spyOn(client, 'call')
  beforeEach(() => {
    call.mockReset()
  })

  it('records yield without control, suspension, or a required parallel reason', async () => {
    call.mockResolvedValue({
      id: 'receipt',
      _meta: { runtimeId: 'fixture-runtime' },
      ok: true,
      result: { runId: 'run_fixture' }
    })
    await ORCHESTRATION_RUN_HANDLERS['orchestration yield']({
      flags: new Map([['run', 'run_fixture']]),
      client,
      cwd: '/tmp/fixture',
      json: true
    })
    expect(call).toHaveBeenCalledExactlyOnceWith('orchestration.yield', {
      from: 'term_lead',
      run: 'run_fixture'
    })
  })

  it('ordinary actions add no capability probe', async () => {
    expect(await parallelWorkEvidence(new Map(), client)).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses to silently drop an explicit parallel reason on an older host', async () => {
    call.mockResolvedValue({
      id: 'status',
      _meta: { runtimeId: 'fixture-runtime' },
      ok: true,
      result: { capabilities: [] }
    })
    await expect(
      parallelWorkEvidence(new Map([['parallel-work-reason', 'Independent fixture lint']]), client)
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(call).toHaveBeenCalledExactlyOnceWith('status.get')
  })

  it('normalizes a bounded per-action reason on a capable host', async () => {
    call.mockResolvedValue({
      id: 'status',
      _meta: { runtimeId: 'fixture-runtime' },
      ok: true,
      result: { capabilities: [LEAD_YIELD_RUNTIME_CAPABILITY] }
    })
    expect(
      await parallelWorkEvidence(
        new Map([['parallel-work-reason', '  Independent fixture lint  ']]),
        client
      )
    ).toBe('Independent fixture lint')
    expect(call).toHaveBeenCalledExactlyOnceWith('status.get')
  })
})
