import * as buildIdentity from '../../shared/orca-build-identity'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
} from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { diagnoseCliRuntime, DOCTOR_HANDLERS } from './doctor'
import { RuntimeClient } from '../runtime-client'

const status: RuntimeStatus = {
  runtimeId: 'runtime',
  rendererGraphEpoch: 1,
  graphStatus: 'ready',
  authoritativeWindowId: null,
  liveTabCount: 0,
  liveLeafCount: 0,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
}
const response: RuntimeRpcSuccess<RuntimeStatus> = {
  id: 'status',
  ok: true,
  result: status,
  _meta: { runtimeId: 'runtime' }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
})
describe('doctor', () => {
  it('uses one bounded status request and reports compatibility with local CLI identity', async () => {
    const client = new RuntimeClient(undefined, undefined, null, null)
    const call = vi.spyOn(client, 'call').mockResolvedValue(response)
    const result = await diagnoseCliRuntime(client)
    expect(call).toHaveBeenCalledExactlyOnceWith('status.get', undefined, { timeoutMs: 1000 })
    expect(result).toMatchObject({
      cli: { path: expect.any(String) },
      compatibility: { status: 'PASS' }
    })
  })
  it('reports the canonical launcher path exported by the bundle', async () => {
    vi.stubEnv('ORCA_CLI_COMMAND', '/Applications/Orca MK.app/Contents/Resources/bin/orca')
    const client = new RuntimeClient(undefined, undefined, null, null)
    vi.spyOn(client, 'call').mockResolvedValue(response)
    expect(await diagnoseCliRuntime(client)).toMatchObject({
      cli: { path: '/Applications/Orca MK.app/Contents/Resources/bin/orca' }
    })
  })

  it('reports MK CLI against unidentified runtime as a mismatch', async () => {
    vi.spyOn(buildIdentity, 'readOrcaBuildIdentity').mockReturnValue({
      distribution: 'orca-mk',
      version: '1',
      commit: 'abc',
      sourceFingerprint: 'def',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      minCompatibleRuntimeServerVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
    })
    const client = new RuntimeClient(undefined, undefined, null, null)
    vi.spyOn(client, 'call').mockResolvedValue(response)
    expect(await diagnoseCliRuntime(client)).toMatchObject({
      compatibility: { status: 'FAIL', reason: 'CLI_RUNTIME_MISMATCH' }
    })
  })

  it('returns a mismatch receipt for malformed CLI metadata without probing', async () => {
    vi.spyOn(buildIdentity, 'readOrcaBuildIdentity').mockImplementation(() => {
      throw new Error('Invalid metadata')
    })
    const client = new RuntimeClient(undefined, undefined, null, null)
    const call = vi.spyOn(client, 'call')
    expect(await diagnoseCliRuntime(client)).toMatchObject({
      cli: { identityError: 'Invalid metadata' },
      compatibility: { status: 'FAIL', reason: 'CLI_RUNTIME_MISMATCH' }
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('reports unavailable runtime without retry or launch', async () => {
    const client = new RuntimeClient(undefined, undefined, null, null)
    const call = vi.spyOn(client, 'call').mockRejectedValue(new Error('Offline'))
    expect(await diagnoseCliRuntime(client)).toMatchObject({
      runtime: null,
      compatibility: { status: 'FAIL', reason: 'RUNTIME_UNAVAILABLE' }
    })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it.each([true, false])('prints a reviewable failure receipt for json=%s', async (json) => {
    const client = new RuntimeClient(undefined, undefined, null, null)
    vi.spyOn(client, 'call').mockResolvedValue({
      ...response,
      result: { ...status, runtimeProtocolVersion: undefined }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await DOCTOR_HANDLERS.doctor({ client, json, cwd: '/tmp', flags: new Map() })
    expect(process.exitCode).toBe(1)
    expect(String(log.mock.calls[0]?.[0])).toContain('CLI_RUNTIME_MISMATCH')
    expect(String(log.mock.calls[0]?.[0])).toContain('FAIL')
  })
})
