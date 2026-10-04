import { describe, expect, it, vi } from 'vitest'
import type { OrcaBuildIdentity } from '../../shared/orca-build-identity'

const { identity, readIdentity } = vi.hoisted(() => {
  const identity: OrcaBuildIdentity = {
    distribution: 'orca-mk',
    version: '1',
    commit: 'original',
    sourceFingerprint: 'original',
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 2,
    minCompatibleRuntimeServerVersion: 2
  }
  return { identity, readIdentity: vi.fn(() => identity) }
})
vi.mock('../../shared/orca-build-identity', () => ({ readRuntimeBuildIdentity: readIdentity }))
import { RUNTIME_BUILD_IDENTITY } from './runtime-build-identity'

describe('runtime build identity snapshot', () => {
  it('keeps the startup identity after metadata is replaced', () => {
    expect(RUNTIME_BUILD_IDENTITY).toEqual(identity)
    readIdentity.mockReturnValue({ ...identity, commit: 'replacement', version: '2' })
    expect(RUNTIME_BUILD_IDENTITY).toEqual(identity)
    expect(readIdentity).toHaveBeenCalledTimes(1)
  })
})
