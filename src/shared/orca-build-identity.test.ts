import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from './protocol-version'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseOrcaBuildIdentity,
  readOrcaBuildIdentity,
  resolveOrcaBuildResourcesPath
} from './orca-build-identity'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const identity = {
  distribution: 'orca-mk' as const,
  version: '1.0.0',
  commit: 'abc',
  sourceFingerprint: 'def',
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  minCompatibleRuntimeServerVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
}
function resources() {
  const root = mkdtempSync(join(tmpdir(), 'orca-identity-'))
  roots.push(root)
  return root
}
describe('Orca build identity', () => {
  it('reads root metadata from the bundled shared directory and argv entry', () => {
    const root = resources()
    const directory = join(root, 'app.asar.unpacked', 'out', 'shared')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(root, 'orca-build-identity.json'), JSON.stringify(identity))
    expect(readOrcaBuildIdentity({ moduleDirectory: directory })).toEqual(identity)
    expect(
      readOrcaBuildIdentity({
        moduleDirectory: '/dev/src/shared',
        argvEntry: join(root, 'app.asar.unpacked', 'out', 'cli', 'index.js')
      })
    ).toEqual(identity)
    expect(resolveOrcaBuildResourcesPath({ resourcesPath: root, moduleDirectory: '/dev' })).toBe(
      root
    )
  })
  it('returns null for development and missing metadata', () => {
    expect(readOrcaBuildIdentity({ moduleDirectory: '/dev/src/shared' })).toBeNull()
    expect(readOrcaBuildIdentity({ resourcesPath: resources() })).toBeNull()
  })
  it.each([
    '{',
    JSON.stringify({ ...identity, runtimeProtocolVersion: 99999 }),
    JSON.stringify({ ...identity, distribution: 'other' }),
    JSON.stringify({ ...identity, runtimeProtocolVersion: '3' }),
    ' '.repeat(65537)
  ])('rejects malformed or oversized packaged metadata', (content) => {
    const root = resources()
    writeFileSync(join(root, 'orca-build-identity.json'), content)
    expect(() => readOrcaBuildIdentity({ resourcesPath: root })).toThrow(
      'Cannot read Orca build identity'
    )
  })
  it('rejects empty identity and invalid protocol numbers', () => {
    expect(() => parseOrcaBuildIdentity({ ...identity, commit: '' })).toThrow()
    expect(() =>
      parseOrcaBuildIdentity({ ...identity, minCompatibleRuntimeServerVersion: -1 })
    ).toThrow()
  })
})
