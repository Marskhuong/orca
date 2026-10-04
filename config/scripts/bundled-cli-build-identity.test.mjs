import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const { recordArtifactBuild, verifyBuildPair, verifyPackagedCli } = createRequire(import.meta.url)(
  './bundled-cli-build-identity.cjs'
)
const roots = []
const identity = {
  distribution: 'orca-mk',
  version: '1.2.3',
  commit: 'abc',
  sourceFingerprint: 'def',
  runtimeProtocolVersion: 3,
  minCompatibleRuntimeClientVersion: 2,
  minCompatibleRuntimeServerVersion: 2
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mk-cli-build-'))
  roots.push(root)
  for (const kind of ['cli', 'main', 'shared']) {
    mkdirSync(join(root, 'out', kind), { recursive: true })
    writeFileSync(join(root, 'out', kind, 'index.js'), 'module.exports = {}')
  }
  recordArtifactBuild('cli', root, identity)
  recordArtifactBuild('main', root, identity)
  return root
}
function packaged(root) {
  const resources = join(root, 'Resources')
  mkdirSync(join(resources, 'app.asar.unpacked'), { recursive: true })
  cpSync(join(root, 'out'), join(resources, 'app.asar.unpacked/out'), { recursive: true })
  mkdirSync(join(resources, 'bin'))
  writeFileSync(join(resources, 'bin/orca'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return resources
}
describe('MK bundled CLI build invariant', () => {
  it('accepts CLI and runtime from the same source and protocol', () => {
    const root = fixture()
    expect(verifyBuildPair(join(root, 'out'), identity)).toEqual(identity)
  })
  it.each(['version', 'commit', 'sourceFingerprint', 'runtimeProtocolVersion', 'distribution'])(
    'refuses mismatched %s',
    (field) => {
      const root = fixture()
      recordArtifactBuild('cli', root, { ...identity, [field]: 'changed' })
      expect(() => verifyBuildPair(join(root, 'out'), identity)).toThrow('mismatch')
    }
  )
  it('fails when CLI is absent', () => {
    const root = fixture()
    rmSync(join(root, 'out/cli'), { recursive: true })
    expect(() => verifyBuildPair(join(root, 'out'), identity)).toThrow()
  })
  it('fails if built CLI code is replaced', () => {
    const root = fixture()
    writeFileSync(join(root, 'out/cli/index.js'), 'changed')
    expect(() => verifyBuildPair(join(root, 'out'), identity)).toThrow('changed after build')
  })
  it('fails if shared CLI dependencies are replaced', () => {
    const root = fixture()
    writeFileSync(join(root, 'out/shared/index.js'), 'changed')
    expect(() => verifyBuildPair(join(root, 'out'), identity)).toThrow('shared modules changed')
  })
  it('writes shared runtime/CLI metadata only for an executable packaged CLI', () => {
    const root = fixture()
    const resources = packaged(root)
    verifyPackagedCli(resources, identity, 'darwin')
    expect(JSON.parse(readFileSync(join(resources, 'orca-build-identity.json')))).toEqual(identity)
  })
  it('refuses a missing packaged launcher', () => {
    const resources = packaged(fixture())
    unlinkSync(join(resources, 'bin/orca'))
    expect(() => verifyPackagedCli(resources, identity, 'darwin')).toThrow()
  })
  it('refuses a non-executable packaged launcher', () => {
    const resources = packaged(fixture())
    chmodSync(join(resources, 'bin/orca'), 0o644)
    expect(() => verifyPackagedCli(resources, identity, 'darwin')).toThrow('not executable')
  })
  it('refuses a stale packaged CLI', () => {
    const resources = packaged(fixture())
    expect(() =>
      verifyPackagedCli(resources, { ...identity, commit: 'different' }, 'darwin')
    ).toThrow('mismatch')
  })
})
