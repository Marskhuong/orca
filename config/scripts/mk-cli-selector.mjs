import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { symlink } from 'node:fs/promises'
import { quoteShell } from '../../src/shared/shell-quote.ts'
import { pathToFileURL } from 'node:url'

export const DEFAULT_MK_APP = '/Applications/Orca MK.app'

function linkTarget(selector) {
  try {
    if (!lstatSync(selector).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite a file: ${selector}`)
    }
    return readlinkSync(selector)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function replaceLink(selector, target, inspected, transaction) {
  const held = await transaction.quarantineCommandPath(selector)
  if (!(await transaction.capturedExpectedEntry(held, inspected))) {
    await transaction.restoreQuarantinedCommand(held, selector)
    throw new Error('Selector changed during migration; no replacement authorized')
  }
  try {
    if (target !== null) {
      await symlink(target, selector)
    }
  } catch (error) {
    await transaction.restoreQuarantinedCommand(held, selector)
    throw error
  }
  await transaction.discardQuarantinedCommand(held)
}

async function selectorEvidence(selector, transaction) {
  const snapshot = await transaction.readEntrySnapshot(selector)
  const rawSymlinkTarget = linkTarget(selector)
  const after = await transaction.readEntrySnapshot(selector)
  if (!transaction.hasSameSnapshot(snapshot, after)) {
    throw new Error('Selector changed during inspection')
  }
  return { snapshot, rawSymlinkTarget, fileSha256: null }
}

async function loadTransaction() {
  return import('../../out/shared/cli-command-filesystem-transaction.js')
}

export async function installMkCliSelector({
  appPath = DEFAULT_MK_APP,
  selector = join(homedir(), '.local/bin/orca'),
  statePath = join(homedir(), '.local/state/orca-mk/cli-selector.json'),
  replaceExistingSelector = false,
  verifyApp = true,
  transaction
} = {}) {
  const resources = join(resolve(appPath), 'Contents/Resources')
  const identity = JSON.parse(readFileSync(join(resources, 'orca-build-identity.json'), 'utf8'))
  if (identity.distribution !== 'orca-mk') {
    throw new Error('Selected bundle is not Orca MK')
  }
  if (verifyApp) {
    const appId = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', join(resolve(appPath), 'Contents/Info.plist')],
      { encoding: 'utf8' }
    ).trim()
    if (appId !== 'com.stablyai.orca.mk') {
      throw new Error('Selected app is not the MK distribution')
    }
    execFileSync('codesign', ['--verify', '--deep', '--strict', resolve(appPath)], {
      stdio: 'pipe'
    })
  }
  const bundledCli = join(resources, 'bin/orca')
  const stats = lstatSync(bundledCli)
  if (!stats.isFile() || (stats.mode & 0o111) === 0) {
    throw new Error('Bundled MK CLI is missing or not executable')
  }
  transaction ??= await loadTransaction()
  const inspected = await selectorEvidence(selector, transaction)
  const previous = inspected.rawSymlinkTarget
  const target = join(dirname(statePath), 'bin', 'orca')
  const launcher = `#!/bin/sh\n# Orca MK CLI selector v1\nexec ${quoteShell(bundledCli)} "$@"\n`
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (existsSync(target)) {
    if (!lstatSync(target).isFile() || readFileSync(target, 'utf8') !== launcher) {
      throw new Error('Protected MK launcher changed; refusing replacement')
    }
  } else {
    writeFileSync(target, launcher, { flag: 'wx', mode: 0o755 })
  }
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
  if (previous === target) {
    return { selector, target, bundledCli, changed: false, previous: state?.previous ?? null }
  }
  if (previous !== null && previous !== state?.target && !replaceExistingSelector) {
    throw new Error(
      `Existing selector points to ${previous}; no change made. Use --replace-existing-selector to preserve it for rollback and activate MK.`
    )
  }
  if (state && state.selector !== selector) {
    throw new Error('Rollback state belongs to another selector')
  }
  if (
    state &&
    previous !== state.target &&
    !(state.pending === true && previous === state.previous)
  ) {
    throw new Error(
      'Selector changed outside MK; rollback state must be reconciled before migration'
    )
  }
  mkdirSync(dirname(statePath), { recursive: true })
  const nextState = {
    selector,
    target,
    bundledCli,
    previous: state ? state.previous : previous,
    pending: true
  }
  writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 })
  await replaceLink(selector, target, inspected, transaction)
  nextState.pending = false
  writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 })
  return { ...nextState, changed: true }
}

export async function rollbackMkCliSelector({
  statePath = join(homedir(), '.local/state/orca-mk/cli-selector.json'),
  transaction
} = {}) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  if (
    typeof state.selector !== 'string' ||
    typeof state.target !== 'string' ||
    (state.previous !== null && typeof state.previous !== 'string')
  ) {
    throw new Error('Malformed MK selector rollback state')
  }
  transaction ??= await loadTransaction()
  const inspected = await selectorEvidence(state.selector, transaction)
  if (inspected.rawSymlinkTarget !== state.target) {
    throw new Error('Selector changed outside MK; refusing rollback')
  }
  await replaceLink(state.selector, state.previous, inspected, transaction)
  unlinkSync(statePath)
  return { selector: state.selector, restoredTarget: state.previous }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.platform !== 'darwin') {
      throw new Error('MK CLI selector installation is macOS-only')
    }
    const args = process.argv.slice(2)
    const result = args.includes('--rollback')
      ? await rollbackMkCliSelector()
      : await installMkCliSelector({
          appPath: args.find((arg) => arg.startsWith('--app='))?.slice(6),
          replaceExistingSelector: args.includes('--replace-existing-selector')
        })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
