import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from './protocol-version'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type OrcaBuildIdentity = {
  distribution: 'orca-mk' | 'orca'
  version: string
  commit: string
  sourceFingerprint: string
  runtimeProtocolVersion: number
  minCompatibleRuntimeClientVersion: number
  minCompatibleRuntimeServerVersion: number
}

const IDENTITY_FILE = 'orca-build-identity.json'
const MAX_IDENTITY_BYTES = 64 * 1024

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function protocol(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parseOrcaBuildIdentity(value: unknown): OrcaBuildIdentity {
  if (
    !value ||
    typeof value !== 'object' ||
    !('distribution' in value) ||
    (value.distribution !== 'orca-mk' && value.distribution !== 'orca') ||
    !('version' in value) ||
    !nonempty(value.version) ||
    !('commit' in value) ||
    !nonempty(value.commit) ||
    !('sourceFingerprint' in value) ||
    !nonempty(value.sourceFingerprint) ||
    !('runtimeProtocolVersion' in value) ||
    !protocol(value.runtimeProtocolVersion) ||
    !('minCompatibleRuntimeClientVersion' in value) ||
    !protocol(value.minCompatibleRuntimeClientVersion) ||
    !('minCompatibleRuntimeServerVersion' in value) ||
    !protocol(value.minCompatibleRuntimeServerVersion)
  ) {
    throw new Error('Invalid Orca build identity metadata')
  }
  return {
    distribution: value.distribution,
    version: value.version,
    commit: value.commit,
    sourceFingerprint: value.sourceFingerprint,
    runtimeProtocolVersion: value.runtimeProtocolVersion,
    minCompatibleRuntimeClientVersion: value.minCompatibleRuntimeClientVersion,
    minCompatibleRuntimeServerVersion: value.minCompatibleRuntimeServerVersion
  }
}

function bundledResourcesRoot(directory: string): string | null {
  const out = dirname(directory)
  const unpacked = dirname(out)
  return basename(out) === 'out' && basename(unpacked) === 'app.asar.unpacked'
    ? dirname(unpacked)
    : null
}

export function resolveOrcaBuildResourcesPath(
  options: {
    resourcesPath?: string
    moduleDirectory?: string
    argvEntry?: string
  } = {}
): string | null {
  if (options.resourcesPath) {
    return options.resourcesPath
  }
  return (
    bundledResourcesRoot(options.moduleDirectory ?? __dirname) ??
    (options.argvEntry ? bundledResourcesRoot(dirname(resolve(options.argvEntry))) : null)
  )
}

export function readOrcaBuildIdentity(
  options: {
    resourcesPath?: string
    moduleDirectory?: string
    argvEntry?: string
  } = {}
): OrcaBuildIdentity | null {
  const resourcesPath = resolveOrcaBuildResourcesPath(options)
  if (!resourcesPath) {
    return null
  }
  const file = join(resourcesPath, IDENTITY_FILE)
  try {
    if (statSync(file).size > MAX_IDENTITY_BYTES) {
      throw new Error('Orca build identity metadata exceeds 64 KiB')
    }
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const identity = parseOrcaBuildIdentity(value)
    if (
      identity.runtimeProtocolVersion !== RUNTIME_PROTOCOL_VERSION ||
      identity.minCompatibleRuntimeClientVersion !== MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION ||
      identity.minCompatibleRuntimeServerVersion !== MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
    ) {
      throw new Error('Orca build identity protocol fields disagree with this executable')
    }
    return identity
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw new Error(`Cannot read Orca build identity at ${file}`, { cause: error })
  }
}

export function readRuntimeBuildIdentity(): OrcaBuildIdentity | null {
  return readOrcaBuildIdentity({
    resourcesPath:
      'resourcesPath' in process && typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : undefined,
    argvEntry: process.argv[1]
  })
}
