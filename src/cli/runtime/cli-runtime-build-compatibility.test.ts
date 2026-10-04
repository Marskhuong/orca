import { describe, expect, it } from 'vitest'
import type { OrcaBuildIdentity } from '../../shared/orca-build-identity'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { evaluateCliRuntimeBuildCompatibility } from './cli-runtime-build-compatibility'

const cli: OrcaBuildIdentity = {
  distribution: 'orca-mk',
  version: '1',
  commit: 'abc',
  sourceFingerprint: 'def',
  runtimeProtocolVersion: 3,
  minCompatibleRuntimeClientVersion: 2,
  minCompatibleRuntimeServerVersion: 2
}
const runtime: RuntimeStatus = {
  runtimeId: 'r',
  rendererGraphEpoch: 1,
  graphStatus: 'ready',
  authoritativeWindowId: null,
  liveTabCount: 0,
  liveLeafCount: 0,
  runtimeProtocolVersion: 3,
  minCompatibleRuntimeClientVersion: 2,
  buildIdentity: cli
}
describe('CLI/runtime build compatibility', () => {
  it('passes supported protocol skew despite different versions, commits and fingerprints', () => {
    expect(
      evaluateCliRuntimeBuildCompatibility(cli, {
        ...runtime,
        runtimeProtocolVersion: 4,
        buildIdentity: {
          ...cli,
          version: '2',
          commit: 'other',
          sourceFingerprint: 'other',
          runtimeProtocolVersion: 4
        }
      })
    ).toMatchObject({ status: 'PASS' })
  })
  it('fails protocol skew outside the supported range', () => {
    expect(
      evaluateCliRuntimeBuildCompatibility(cli, {
        ...runtime,
        minCompatibleRuntimeClientVersion: 4,
        buildIdentity: { ...cli, minCompatibleRuntimeClientVersion: 4 }
      })
    ).toMatchObject({ status: 'FAIL', reason: 'CLI_RUNTIME_MISMATCH' })
  })
  it('fails unknown protocol and absent or official identity for MK', () => {
    for (const status of [
      { ...runtime, buildIdentity: undefined },
      { ...runtime, buildIdentity: { ...cli, distribution: 'orca' as const } },
      { ...runtime, runtimeProtocolVersion: undefined }
    ]) {
      expect(evaluateCliRuntimeBuildCompatibility(cli, status).status).toBe('FAIL')
    }
  })
  it('preserves generic identity-optional compatibility', () => {
    expect(
      evaluateCliRuntimeBuildCompatibility(null, { ...runtime, buildIdentity: undefined }).status
    ).toBe('PASS')
  })
})
