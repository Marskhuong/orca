import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.useRealTimers()
})
const conversationId = '092bded8-ae9c-48a1-8675-4285a4ede1a2'
async function setup() {
  const capability = await import('./antigravity-completion-capability')
  const adapter = await import('./antigravity-stop-completion')
  const complete = vi.fn()
  const assertCurrent = vi.fn()
  const token = capability.issueAntigravityCompletion({
    dispatchId: 'ctx_agy',
    runtimeId: 'runtime_agy',
    complete
  })
  adapter.registerAntigravityStopCompletion('pane_agy', {
    dispatchId: 'ctx_agy',
    runtimeId: 'runtime_agy',
    capability: token,
    launchTokenHash: createHash('sha256').update('launch-secret').digest('hex'),
    model: 'gemini-3.8-flash-high',
    workspacePath: '/fixture',
    assertCurrent
  })
  const hook = {
    conversationId,
    modelName: 'gemini-3.8-flash-high',
    workspacePaths: ['/fixture'],
    terminationReason: 'NO_TOOL_CALL',
    fullyIdle: true,
    error: ''
  }
  const envelope = (event: string, payload: unknown = hook) => ({
    paneKey: 'pane_agy',
    launchToken: 'launch-secret',
    hook_event_name: event,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload)
  })
  adapter.observeAntigravityCompletionHook(envelope('PreInvocation'))
  return { ...adapter, ...capability, complete, assertCurrent, token, hook, envelope }
}

describe('verified installed AGY Stop contract', () => {
  it('normal idle Stop consumes exactly one completion capability', async () => {
    const f = await setup()
    f.observeAntigravityCompletionHook(f.envelope('Stop'))
    f.observeAntigravityCompletionHook(f.envelope('Stop'))
    expect(f.complete).toHaveBeenCalledExactlyOnceWith({
      dispatchId: 'ctx_agy',
      runtimeId: 'runtime_agy',
      outcome: 'succeeded',
      summary: 'AGY Stop: NO_TOOL_CALL'
    })
    expect(() => f.redeemAntigravityCompletion(f.token, {})).toThrow()
  })
  it.each([
    { conversationId: '192bded8-ae9c-48a1-8675-4285a4ede1a2' },
    { modelName: 'other-model' },
    { workspacePaths: ['/other'] },
    { workspacePaths: ['/fixture', '/other'] }
  ])('rejects wrong lifecycle context %j', async (change) => {
    const f = await setup()
    expect(() =>
      f.observeAntigravityCompletionHook(f.envelope('Stop', { ...f.hook, ...change }))
    ).toThrow()
    expect(f.complete).not.toHaveBeenCalled()
  })
  it.each([false, undefined])('does not claim success with fullyIdle=%s', async (fullyIdle) => {
    const f = await setup()
    f.observeAntigravityCompletionHook(f.envelope('Stop', { ...f.hook, fullyIdle }))
    expect(f.complete).not.toHaveBeenCalled()
  })
  it('settles explicit provider error as failed, never succeeded', async () => {
    const f = await setup()
    f.observeAntigravityCompletionHook(
      f.envelope('Stop', { ...f.hook, terminationReason: 'error', error: 'provider failed' })
    )
    expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
  })
  it('ambiguous terminal reasons remain unsettled', async () => {
    const f = await setup()
    f.observeAntigravityCompletionHook(
      f.envelope('Stop', { ...f.hook, terminationReason: 'unverified' })
    )
    expect(f.complete).not.toHaveBeenCalled()
  })
  it.each(['{', '{}'])('malformed payload %s cannot complete', async (payload) => {
    const f = await setup()
    expect(() => f.observeAntigravityCompletionHook(f.envelope('Stop', payload))).toThrow()
    expect(f.complete).not.toHaveBeenCalled()
  })
  it('rejects a wrong launch secret', async () => {
    const f = await setup()
    expect(() =>
      f.observeAntigravityCompletionHook({ ...f.envelope('Stop'), launchToken: 'other' })
    ).toThrow()
    expect(f.complete).not.toHaveBeenCalled()
  })
  it('expiry refuses completion', async () => {
    const f = await setup()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + f.ANTIGRAVITY_COMPLETION_TTL_MS + 1)
    f.observeAntigravityCompletionHook(f.envelope('Stop'))
    expect(f.complete).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('restart loses mapping and changed process authority refuses completion', async () => {
    const f = await setup()
    f.assertCurrent.mockImplementation(() => {
      throw new Error('replaced-runtime-or-process')
    })
    expect(() => f.observeAntigravityCompletionHook(f.envelope('Stop'))).toThrow()
    vi.resetModules()
    const restarted = await import('./antigravity-stop-completion')
    restarted.observeAntigravityCompletionHook(f.envelope('Stop'))
    expect(f.complete).not.toHaveBeenCalled()
  })
  it('rejects conflicting registration and ignores non-Stop completion events', async () => {
    const f = await setup()
    f.observeAntigravityCompletionHook(f.envelope('PostInvocation'))
    expect(f.complete).not.toHaveBeenCalled()
    const second = { ...f.envelope('PreInvocation'), paneKey: 'not-registered' }
    f.observeAntigravityCompletionHook(second)
    expect(f.complete).not.toHaveBeenCalled()
  })
})
