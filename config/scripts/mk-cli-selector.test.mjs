import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installMkCliSelector, rollbackMkCliSelector } from './mk-cli-selector.mjs'
import * as transaction from '../../src/main/cli/cli-command-filesystem-transaction'
const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mk-selector-'))
  roots.push(root)
  const appPath = join(root, 'Orca MK.app'),
    resources = join(appPath, 'Contents/Resources')
  mkdirSync(join(resources, 'bin'), { recursive: true })
  writeFileSync(
    join(resources, 'orca-build-identity.json'),
    JSON.stringify({ distribution: 'orca-mk' })
  )
  writeFileSync(join(resources, 'bin/orca'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return {
    appPath,
    selector: join(root, 'orca'),
    statePath: join(root, 'state.json'),
    transaction,
    verifyApp: false
  }
}
describe('MK CLI selector', async () => {
  it('forwards to the bundled CLI from a protected selector and installs idempotently', async () => {
    const options = fixture()
    const first = await installMkCliSelector(options)
    expect(readlinkSync(options.selector)).toBe(first.target)
    expect(readFileSync(first.target, 'utf8')).toContain(first.bundledCli)
    expect(first.target).not.toContain('.app/Contents/Resources/bin/orca')
    expect((await installMkCliSelector(options)).changed).toBe(false)
  })
  it('does not silently overwrite an official selector', async () => {
    const options = fixture()
    symlinkSync('/Applications/Orca.app/Contents/Resources/bin/orca', options.selector)
    await expect(installMkCliSelector(options)).rejects.toThrow('no change made')
    expect(readlinkSync(options.selector)).toContain('/Applications/Orca.app/')
  })
  it('preserves explicit official selector migration and rollback', async () => {
    const options = fixture()
    const official = '/Applications/Orca.app/Contents/Resources/bin/orca'
    symlinkSync(official, options.selector)
    await installMkCliSelector({ ...options, replaceExistingSelector: true })
    await installMkCliSelector(options)
    expect(JSON.parse(readFileSync(options.statePath)).previous).toBe(official)
    await rollbackMkCliSelector(options)
    expect(readlinkSync(options.selector)).toBe(official)
  })
  it('rollback removes a newly installed selector', async () => {
    const options = fixture()
    await installMkCliSelector(options)
    await rollbackMkCliSelector(options)
    expect(existsSync(options.selector)).toBe(false)
  })
  it('never overwrites an unrelated executable even with explicit replacement', async () => {
    const options = fixture()
    writeFileSync(options.selector, 'other program')
    await expect(
      installMkCliSelector({ ...options, replaceExistingSelector: true })
    ).rejects.toThrow('Refusing to overwrite')
    expect(readFileSync(options.selector, 'utf8')).toBe('other program')
  })
  it('refuses non-MK bundles', async () => {
    const options = fixture()
    writeFileSync(
      join(options.appPath, 'Contents/Resources/orca-build-identity.json'),
      JSON.stringify({ distribution: 'orca' })
    )
    await expect(installMkCliSelector(options)).rejects.toThrow('not Orca MK')
  })
  it('refuses rollback if another program changes the selector', async () => {
    const options = fixture()
    await installMkCliSelector(options)
    rmSync(options.selector)
    symlinkSync('/different', options.selector)
    await expect(rollbackMkCliSelector(options)).rejects.toThrow('refusing rollback')
  })
  it('preserves an unrelated selector introduced during migration', async () => {
    const options = fixture()
    symlinkSync('/Applications/Orca.app/Contents/Resources/bin/orca', options.selector)
    const raced = {
      ...transaction,
      async quarantineCommandPath(path) {
        rmSync(path)
        symlinkSync('/foreign/racing-command', path)
        return transaction.quarantineCommandPath(path)
      }
    }
    await expect(
      installMkCliSelector({ ...options, replaceExistingSelector: true, transaction: raced })
    ).rejects.toThrow('Selector changed during migration')
    expect(readlinkSync(options.selector)).toBe('/foreign/racing-command')
  })
})
