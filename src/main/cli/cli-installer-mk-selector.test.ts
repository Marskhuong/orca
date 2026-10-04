import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'
import { quoteShell } from '../../shared/shell-quote'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() }
}))
import { CliInstaller } from './cli-installer'
import { makeFixture } from './cli-installer-test-fixtures'
import { buildMkCliSelectorLauncher, mkCliSelectorLauncherPath } from './mk-cli-selector-launcher'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const base = await makeFixture()
  roots.push(base.root)
  const homePath = join(base.root, 'home')
  const commandPath = join(homePath, '.local', 'bin', 'orca')
  const resourcesPath = join(base.root, "Orca MK's.app", 'Contents', 'Resources')
  const launcherPath = join(resourcesPath, 'bin', 'orca')
  const officialResources = join(base.root, 'Official.app', 'Contents', 'Resources')
  const officialLauncher = join(officialResources, 'bin', 'orca')
  await mkdir(join(resourcesPath, 'bin'), { recursive: true })
  await mkdir(join(officialResources, 'bin'), { recursive: true })
  await mkdir(join(homePath, '.local', 'bin'), { recursive: true })
  for (const path of [launcherPath, officialLauncher]) {
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  await writeFile(
    join(resourcesPath, 'orca-build-identity.json'),
    JSON.stringify({
      distribution: 'orca-mk',
      version: '1',
      commit: 'commit',
      sourceFingerprint: 'source',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      minCompatibleRuntimeServerVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
    })
  )
  const privilegedRunner = vi.fn(async () => {})
  const options = {
    platform: 'darwin' as const,
    isPackaged: true,
    resourcesPath,
    homePath,
    userDataPath: base.userDataPath,
    processPathEnv: join(homePath, '.local', 'bin'),
    privilegedRunner
  }
  return {
    ...base,
    options,
    homePath,
    commandPath,
    resourcesPath,
    launcherPath,
    officialResources,
    officialLauncher,
    privilegedRunner
  }
}

// Unix symlink behavior is exercised on native macOS/Linux only.
describe.skipIf(process.platform === 'win32')('MK native CLI selector protection', () => {
  it('recognizes the migrated protected selector idempotently without changing either inode', async () => {
    const f = await fixture()
    const shim = mkCliSelectorLauncherPath(f.homePath)
    await mkdir(join(shim, '..'), { recursive: true })
    const content = buildMkCliSelectorLauncher(f.launcherPath)
    await writeFile(shim, content, { mode: 0o755 })
    await symlink(shim, f.commandPath)
    const before = await lstat(f.commandPath)
    const shimBefore = await lstat(shim)
    const installer = new CliInstaller(f.options)
    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'installed',
      commandPath: f.commandPath
    })
    await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
    await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
    expect((await lstat(f.commandPath)).ino).toBe(before.ino)
    expect((await lstat(shim)).ino).toBe(shimBefore.ino)
    expect(await readFile(shim, 'utf8')).toBe(content)
    expect(f.privilegedRunner).not.toHaveBeenCalled()
  })

  it('pins new MK installation to the home selector and preserves official and Homebrew paths', async () => {
    const f = await fixture()
    const officialCommand = join(f.root, 'usr', 'local', 'bin', 'orca')
    const homebrewCommand = join(f.root, 'opt', 'homebrew', 'bin', 'orca')
    for (const command of [officialCommand, homebrewCommand]) {
      await mkdir(join(command, '..'), { recursive: true })
      await symlink(f.officialLauncher, command)
    }
    const installer = new CliInstaller({
      ...f.options,
      defaultMacCommandPath: officialCommand,
      commandPathOverride: homebrewCommand,
      processPathEnv: [
        join(officialCommand, '..'),
        join(homebrewCommand, '..'),
        join(f.commandPath, '..')
      ].join(':')
    })
    await expect(installer.install()).resolves.toMatchObject({
      commandPath: f.commandPath,
      state: 'installed'
    })
    expect(await readlink(f.commandPath)).toBe(mkCliSelectorLauncherPath(f.homePath))
    expect(await readFile(mkCliSelectorLauncherPath(f.homePath), 'utf8')).toBe(
      buildMkCliSelectorLauncher(f.launcherPath)
    )
    for (const command of [officialCommand, homebrewCommand]) {
      expect(await readlink(command)).toBe(f.officialLauncher)
    }
    expect(f.privilegedRunner).not.toHaveBeenCalled()
  })

  it('official registration refuses the protected selector rather than reclaiming MK', async () => {
    const f = await fixture()
    await new CliInstaller(f.options).install()
    const official = new CliInstaller({
      ...f.options,
      resourcesPath: f.officialResources,
      commandPathOverride: f.commandPath
    })
    await expect(official.getStatus()).resolves.toMatchObject({ state: 'conflict' })
    await expect(official.install()).rejects.toThrow('Refusing to replace')
    await expect(official.remove()).rejects.toThrow('Refusing to remove')
    expect(await readlink(f.commandPath)).toBe(mkCliSelectorLauncherPath(f.homePath))
    expect(await readFile(mkCliSelectorLauncherPath(f.homePath), 'utf8')).toBe(
      buildMkCliSelectorLauncher(f.launcherPath)
    )
  })

  it('MK registration refuses an official app symlink occupying the default selector', async () => {
    const f = await fixture()
    await symlink(f.officialLauncher, f.commandPath)
    const installer = new CliInstaller(f.options)
    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'conflict',
      commandPath: f.commandPath
    })
    await expect(installer.install()).rejects.toThrow('Refusing to replace')
    await expect(installer.remove()).rejects.toThrow('Refusing to remove')
    expect(await readlink(f.commandPath)).toBe(f.officialLauncher)
    await expect(lstat(mkCliSelectorLauncherPath(f.homePath))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('converts its own direct bundle symlink through the existing selector transaction', async () => {
    const f = await fixture()
    await symlink(f.launcherPath, f.commandPath)
    const installer = new CliInstaller(f.options)
    await expect(installer.getStatus()).resolves.toMatchObject({ state: 'stale' })
    await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
    expect(await readlink(f.commandPath)).toBe(mkCliSelectorLauncherPath(f.homePath))
  })

  it('refuses a protected-path shim that forwards to another bundle', async () => {
    const f = await fixture()
    const shim = mkCliSelectorLauncherPath(f.homePath)
    await mkdir(join(shim, '..'), { recursive: true })
    const content = buildMkCliSelectorLauncher(f.officialLauncher)
    await writeFile(shim, content, { mode: 0o755 })
    await symlink(shim, f.commandPath)
    const installer = new CliInstaller(f.options)
    await expect(installer.getStatus()).resolves.toMatchObject({ state: 'conflict' })
    await expect(installer.install()).rejects.toThrow('Refusing to replace')
    expect(await readFile(shim, 'utf8')).toBe(content)
  })

  it('uses the exact migration marker and existing shell quoting', () => {
    const launcher = "/Applications/Orca's MK.app/Contents/Resources/bin/orca"
    expect(buildMkCliSelectorLauncher(launcher)).toBe(
      `#!/bin/sh\n# Orca MK CLI selector v1\nexec ${quoteShell(launcher)} "$@"\n`
    )
  })
})
