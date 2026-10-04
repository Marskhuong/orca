import { readOrcaBuildIdentity, type OrcaBuildIdentity } from '../../shared/orca-build-identity'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { readOrcaCliVersion } from '../cli-version'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { evaluateCliRuntimeBuildCompatibility } from '../runtime/cli-runtime-build-compatibility'
import type { RuntimeClient } from '../runtime-client'

export async function diagnoseCliRuntime(client: Pick<RuntimeClient, 'call'>) {
  let buildIdentity: OrcaBuildIdentity | null = null
  let identityError: string | null = null
  try {
    buildIdentity = readOrcaBuildIdentity({ argvEntry: process.argv[1] })
  } catch (error) {
    identityError = error instanceof Error ? error.message : 'Invalid CLI build identity'
  }
  const cli = {
    path: process.env.ORCA_CLI_COMMAND || process.argv[1] || process.execPath,
    buildIdentity,
    identityError,
    version: readOrcaCliVersion(),
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    minCompatibleRuntimeServerVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
  }
  if (identityError) {
    return {
      cli,
      runtime: null,
      compatibility: {
        status: 'FAIL' as const,
        reason: 'CLI_RUNTIME_MISMATCH' as const,
        message: identityError
      }
    }
  }
  let runtime: RuntimeStatus
  try {
    runtime = (await client.call<RuntimeStatus>('status.get', undefined, { timeoutMs: 1000 }))
      .result
  } catch (error) {
    return {
      cli,
      runtime: null,
      compatibility: {
        status: 'FAIL' as const,
        reason: 'RUNTIME_UNAVAILABLE' as const,
        message: error instanceof Error ? error.message : 'Runtime unavailable'
      }
    }
  }
  return {
    cli,
    runtime,
    compatibility: evaluateCliRuntimeBuildCompatibility(cli.buildIdentity, runtime)
  }
}

export const DOCTOR_HANDLERS: Record<string, CommandHandler> = {
  doctor: async ({ client, json }) => {
    const result = await diagnoseCliRuntime(client)
    if (result.compatibility.status === 'FAIL') {
      process.exitCode = 1
    }
    printResult(
      {
        id: 'doctor',
        ok: true,
        result,
        _meta: { runtimeId: result.runtime?.runtimeId ?? 'unavailable' }
      },
      json,
      (receipt) => {
        const cli = receipt.cli.buildIdentity
        const runtime = receipt.runtime?.buildIdentity
        return [
          `CLI: ${receipt.cli.path}`,
          `CLI build: ${cli?.distribution ?? 'unidentified'} ${cli?.version ?? receipt.cli.version ?? 'unknown'} commit ${cli?.commit ?? 'unknown'} protocol ${cli?.runtimeProtocolVersion ?? receipt.cli.runtimeProtocolVersion}`,
          `Runtime build: ${runtime?.distribution ?? 'unidentified'} ${runtime?.version ?? receipt.runtime?.appVersion ?? 'unknown'} commit ${runtime?.commit ?? 'unknown'} protocol ${receipt.runtime?.runtimeProtocolVersion ?? receipt.runtime?.protocolVersion ?? 'unknown'}`,
          `${receipt.compatibility.status} ${receipt.compatibility.reason}: ${receipt.compatibility.message}`
        ].join('\n')
      }
    )
  }
}
