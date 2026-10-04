import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_DISPATCH_HANDLER } from './orchestration/dispatch-handlers'
import { ROUTE_DISPATCH_RUNTIME_CAPABILITY } from '../../shared/orchestration-route-dispatch'

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('./orchestration/terminal-identity', () => ({
  resolveCoordinatorTerminalHandle: vi.fn(async () => 'term_coord')
}))

const call = vi.fn()
const invoke = () =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the mocked client call is used; assertions verify status preflight precedes mutation.
  ORCHESTRATION_DISPATCH_HANDLER['orchestration dispatch']({
    flags: new Map([
      ['task', 'task_1'],
      ['to', 'term_worker'],
      ['route', 'deepseek']
    ]),
    client: { call },
    cwd: '/tmp/repo',
    json: true
  } as never)

describe('manual dispatch route capability guard', () => {
  beforeEach(() => call.mockReset())

  it.each([{}, { capabilities: [] }])(
    'refuses an older host before dispatch: %j',
    async (status) => {
      call.mockResolvedValue({ result: status })
      await expect(invoke()).rejects.toMatchObject({ code: 'incompatible_runtime' })
      expect(call).toHaveBeenCalledExactlyOnceWith('status.get')
    }
  )

  it('forwards the selected route only after the host advertises enforcement', async () => {
    call
      .mockResolvedValueOnce({ result: { capabilities: [ROUTE_DISPATCH_RUNTIME_CAPABILITY] } })
      .mockResolvedValueOnce({
        result: { dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' } }
      })
    await invoke()
    expect(call).toHaveBeenNthCalledWith(1, 'status.get')
    expect(call).toHaveBeenNthCalledWith(
      2,
      'orchestration.dispatch',
      expect.objectContaining({
        task: 'task_1',
        to: 'term_worker',
        route: 'deepseek'
      })
    )
    expect(call).toHaveBeenCalledTimes(2)
  })
})
