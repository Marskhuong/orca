import { RuntimeClientError, type RuntimeRpcSuccess } from './types'
import type { RuntimeClient } from './client'
import {
  readOrcaBuildIdentity,
  parseOrcaBuildIdentity,
  type OrcaBuildIdentity
} from '../../shared/orca-build-identity'
import { describeRuntimeCompatBlock, evaluateRuntimeCompat } from '../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'

export type CliRuntimeCompatibility = {
  status: 'PASS' | 'FAIL'
  reason: 'COMPATIBLE' | 'CLI_RUNTIME_MISMATCH'
  message: string
}

export function evaluateCliRuntimeBuildCompatibility(
  cli: OrcaBuildIdentity | null,
  runtime: RuntimeStatus
): CliRuntimeCompatibility {
  let identity: OrcaBuildIdentity | null = null
  if (runtime.buildIdentity !== undefined) {
    try {
      identity = parseOrcaBuildIdentity(runtime.buildIdentity)
    } catch {
      return mismatch('The runtime published malformed build identity metadata.')
    }
  }
  if (cli?.distribution === 'orca-mk' && identity?.distribution !== 'orca-mk') {
    return mismatch('The Orca MK CLI requires an Orca MK runtime with build identity metadata.')
  }
  const serverProtocolVersion = runtime.runtimeProtocolVersion ?? runtime.protocolVersion
  const serverMinimum =
    runtime.minCompatibleRuntimeClientVersion ?? runtime.minCompatibleMobileVersion
  if (
    !Number.isSafeInteger(serverProtocolVersion) ||
    !Number.isSafeInteger(serverMinimum) ||
    (serverProtocolVersion ?? -1) < 0 ||
    (serverMinimum ?? -1) < 0
  ) {
    return mismatch('The runtime protocol compatibility range is unknown.')
  }
  if (
    identity &&
    (identity.runtimeProtocolVersion !== serverProtocolVersion ||
      identity.minCompatibleRuntimeClientVersion !== serverMinimum)
  ) {
    return mismatch('The runtime build identity disagrees with its published protocol range.')
  }
  const verdict = evaluateRuntimeCompat({
    clientProtocolVersion: cli?.runtimeProtocolVersion ?? RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion:
      cli?.minCompatibleRuntimeServerVersion ?? MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion,
    serverMinCompatibleClientProtocolVersion: serverMinimum
  })
  return verdict.kind === 'ok'
    ? { status: 'PASS', reason: 'COMPATIBLE', message: describeRuntimeCompatBlock(verdict) }
    : mismatch(describeRuntimeCompatBlock(verdict))
}

function mismatch(message: string): CliRuntimeCompatibility {
  return { status: 'FAIL', reason: 'CLI_RUNTIME_MISMATCH', message }
}

export async function ensureCliRuntimeBuildCompatible(
  client: Pick<RuntimeClient, 'call'>
): Promise<RuntimeRpcSuccess<RuntimeStatus>> {
  let identity: OrcaBuildIdentity | null
  try {
    identity = readOrcaBuildIdentity({ argvEntry: process.argv[1] })
  } catch (error) {
    throw new RuntimeClientError(
      'CLI_RUNTIME_MISMATCH',
      error instanceof Error ? error.message : 'Invalid CLI build identity',
      {
        reason: 'CLI_RUNTIME_MISMATCH',
        effectsApplied: false
      }
    )
  }
  const response = await client.call<RuntimeStatus>('status.get', undefined, { timeoutMs: 1000 })
  const compatibility = evaluateCliRuntimeBuildCompatibility(identity, response.result)
  if (compatibility.status === 'FAIL') {
    throw new RuntimeClientError('CLI_RUNTIME_MISMATCH', compatibility.message, {
      reason: compatibility.reason,
      effectsApplied: false
    })
  }
  return response
}
