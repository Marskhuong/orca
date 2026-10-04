import type * as BuildIdentityModule from '../../shared/orca-build-identity'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readOrcaBuildIdentity } from '../../shared/orca-build-identity'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { RUN_CAPACITY_RUNTIME_CAPABILITY } from '../../shared/orchestration-run-capacity'
import { RuntimeClient } from './client'
import { sendRequest } from './transport'

vi.mock('./metadata', () => ({
  getDefaultUserDataPath: () => '/tmp',
  readMetadata: () => ({ runtimeId: 'runtime' })
}))
vi.mock('./transport', () => ({ sendRequest: vi.fn() }))
vi.mock('../../shared/orca-build-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof BuildIdentityModule>()),
  readOrcaBuildIdentity: vi.fn()
}))
const identity = {
  distribution: 'orca-mk' as const,
  version: '1',
  commit: 'abc',
  sourceFingerprint: 'def',
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  minCompatibleRuntimeServerVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
}
function setup(buildIdentity = identity) {
  vi.mocked(readOrcaBuildIdentity).mockReturnValue(identity)
  vi.mocked(sendRequest).mockImplementation(async (_metadata, method) => ({
    id: 'rpc',
    ok: true,
    result:
      method === 'status.get'
        ? {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            buildIdentity,
            capabilities: [
              RUN_CAPACITY_RUNTIME_CAPABILITY,
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY
            ]
          }
        : {},
    _meta: { runtimeId: 'runtime' }
  }))
  return new RuntimeClient(undefined, undefined, null, null)
}
afterEach(() => {
  vi.resetAllMocks()
})
describe('governed build preflight', () => {
  it.each([
    'orchestration.runCreate',
    'orchestration.runCapacityRecord',
    'orchestration.runCapacityShow',
    'terminal.create',
    'worktree.create'
  ])('refuses %s against official runtime before effects', async (method) => {
    const client = setup()
    vi.mocked(sendRequest).mockResolvedValue({
      id: 's',
      ok: true,
      result: {
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
      },
      _meta: { runtimeId: 'official' }
    })
    await expect(client.call(method, {})).rejects.toMatchObject({
      code: 'CLI_RUNTIME_MISMATCH',
      data: { effectsApplied: false }
    })
    expect(vi.mocked(sendRequest).mock.calls.map((call) => call[1])).toEqual(['status.get'])
  })
  it('allows matching MK runtime and supported version differences', async () => {
    const client = setup({ ...identity, version: '2', commit: 'new' })
    await expect(client.call('orchestration.runCapacityRecord', {})).resolves.toMatchObject({
      ok: true
    })
    expect(vi.mocked(sendRequest).mock.calls.at(-1)?.[1]).toBe('orchestration.runCapacityRecord')
  })
  it('fails unknown protocol for generic CLI before a governed write', async () => {
    const client = setup()
    vi.mocked(readOrcaBuildIdentity).mockReturnValue(null)
    vi.mocked(sendRequest).mockResolvedValue({
      id: 's',
      ok: true,
      result: {},
      _meta: { runtimeId: 'unknown' }
    })
    await expect(client.call('orchestration.runCreate', {})).rejects.toMatchObject({
      code: 'CLI_RUNTIME_MISMATCH'
    })
    expect(vi.mocked(sendRequest).mock.calls.map((call) => call[1])).toEqual(['status.get'])
  })

  it('rejects malformed CLI metadata before any transport request', async () => {
    const client = setup()
    vi.mocked(readOrcaBuildIdentity).mockImplementation(() => {
      throw new Error('Invalid metadata')
    })
    await expect(client.call('orchestration.runCapacityRecord', {})).rejects.toMatchObject({
      code: 'CLI_RUNTIME_MISMATCH',
      data: { effectsApplied: false }
    })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('sends ordinary terminal input without build preflight', async () => {
    const client = setup()
    await client.call('terminal.send', { terminal: 'term', text: 'hello' })
    expect(vi.mocked(sendRequest).mock.calls.map((call) => call[1])).toEqual(['terminal.send'])
    expect(readOrcaBuildIdentity).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'sends terminal prompts without build preflight (legacy=%s)',
    async (legacy) => {
      const client = setup()
      vi.mocked(readOrcaBuildIdentity).mockImplementation(() => {
        throw new Error('Preflight must not run')
      })
      await client.call(
        'terminal.send',
        {
          terminal: 'term',
          text: 'review',
          enter: true,
          agentPrompt: true,
          client: { id: 'orca-cli', type: 'desktop' }
        },
        legacy ? { legacyTerminalPrompt: true } : undefined
      )
      expect(vi.mocked(sendRequest).mock.calls.map((call) => call[1])).toEqual(['terminal.send'])
      expect(readOrcaBuildIdentity).not.toHaveBeenCalled()
    }
  )

  it('does not recurse or probe for status.get', async () => {
    const client = setup()
    await client.call('status.get')
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
})
