import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { quoteShell } from '../../shared/shell-quote'
import { isMissingError } from './cli-install-errors'

export function buildMkCliSelectorLauncher(bundledLauncherPath: string): string {
  return `#!/bin/sh\n# Orca MK CLI selector v1\nexec ${quoteShell(bundledLauncherPath)} "$@"\n`
}

export function mkCliSelectorLauncherPath(homePath: string): string {
  return join(homePath, '.local', 'state', 'orca-mk', 'bin', 'orca')
}

export async function isMkCliSelectorLauncher(
  path: string,
  bundledLauncherPath: string
): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')) === buildMkCliSelectorLauncher(bundledLauncherPath)
  } catch (error) {
    if (isMissingError(error)) {
      return false
    }
    throw error
  }
}

export async function ensureMkCliSelectorLauncher(
  homePath: string,
  bundledLauncherPath: string
): Promise<string> {
  const path = mkCliSelectorLauncherPath(homePath)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, buildMkCliSelectorLauncher(bundledLauncherPath), {
      flag: 'wx',
      mode: 0o755
    })
  } catch (error) {
    if (!(await isMkCliSelectorLauncher(path, bundledLauncherPath))) {
      throw error
    }
  }
  return path
}
