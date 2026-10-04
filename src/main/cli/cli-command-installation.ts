import { ensureMkCliSelectorLauncher } from './mk-cli-selector-launcher'
import { link, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import {
  ensureAppImageExtractedRoot,
  isAppImageExtractedLauncherPath,
  type AppImageExtractedRoot
} from './appimage-extracted-root'
import { CliCommandInspection } from './cli-command-inspection'
import {
  buildMacPrivilegedSymlinkTransaction,
  capturedExpectedEntry,
  inspectStableCommand,
  quarantineCommandPath,
  restoreQuarantinedCommand,
  discardQuarantinedCommand,
  type CommandQuarantine,
  type StableCommandInspection
} from './cli-command-filesystem-transaction'
import { DEV_LAUNCHER_DIR, LEGACY_LINUX_COMMAND_NAME } from './cli-install-constants'
import { buildWindowsForwarder } from './cli-dev-launcher'
import { isPermissionError } from './cli-install-errors'
import { isPathInsideOrEqual } from './cli-install-path-format'

export class CliCommandInstallation extends CliCommandInspection {
  protected async installSymlink(status: CliInstallStatus): Promise<void> {
    const commandPath = status.commandPath
    const launcherPath = status.launcherPath
    if (!commandPath || !launcherPath || status.state === 'installed') {
      return
    }

    const inspected = await this.inspectStableSymlink(commandPath, launcherPath)
    if (inspected.status.state === 'conflict') {
      throw new Error(
        `Refusing to replace non-Orca command at ${commandPath}. Remove it and register again if it is no longer needed.`
      )
    }
    if (inspected.status.state === 'installed') {
      return
    }

    const publishTarget = this.isMkMac
      ? await ensureMkCliSelectorLauncher(this.homePath, launcherPath)
      : launcherPath
    let quarantine: CommandQuarantine
    try {
      quarantine = await this.quarantineCommandPath(commandPath)
    } catch (error) {
      if (this.platform !== 'darwin' || !isPermissionError(error)) {
        throw error
      }
      await this.installSymlinkWithPrivileges(commandPath, launcherPath, inspected, publishTarget)
      return
    }

    if (!(await capturedExpectedEntry(quarantine, inspected))) {
      await this.restoreQuarantinedCommand(quarantine, commandPath)
      throw new Error(
        `Refusing to replace non-Orca command at ${commandPath}. Remove it and register again if it is no longer needed.`
      )
    }

    try {
      await symlink(publishTarget, commandPath)
    } catch (error) {
      await this.restoreQuarantinedCommand(quarantine, commandPath)
      throw error
    }
    await this.discardQuarantinedCommand(quarantine)
  }

  protected async removeSymlink(commandPath: string): Promise<void> {
    const launcherPath = await this.resolveLauncherPath()
    if (!launcherPath) {
      throw new Error('The Orca CLI launcher is no longer available.')
    }
    const inspected = await this.inspectStableSymlink(commandPath, launcherPath)
    if (inspected.status.state === 'not_installed') {
      return
    }
    if (inspected.status.state === 'conflict') {
      throw new Error(`Refusing to remove non-Orca command at ${commandPath}.`)
    }

    let quarantine: CommandQuarantine
    try {
      quarantine = await this.quarantineCommandPath(commandPath)
    } catch (error) {
      if (this.platform !== 'darwin' || !isPermissionError(error)) {
        throw error
      }
      await this.removeSymlinkWithPrivileges(commandPath, inspected)
      return
    }
    if (!(await capturedExpectedEntry(quarantine, inspected))) {
      await this.restoreQuarantinedCommand(quarantine, commandPath)
      throw new Error(`Refusing to remove non-Orca command at ${commandPath}.`)
    }
    await this.discardQuarantinedCommand(quarantine)
  }

  protected async removeLegacyLinuxCommandIfManaged(launcherPath: string | null): Promise<void> {
    if (this.platform !== 'linux' || this.commandPathOverride || !launcherPath) {
      return
    }

    const commandPath = join(this.homePath, '.local', 'bin', LEGACY_LINUX_COMMAND_NAME)
    try {
      const inspected = await this.inspectStableLegacyCommand(commandPath, launcherPath)
      if (!inspected?.managed) {
        return
      }
      const quarantine = await this.quarantineCommandPath(commandPath)
      if (!(await capturedExpectedEntry(quarantine, inspected))) {
        await this.restoreQuarantinedCommand(quarantine, commandPath)
        return
      }
      await this.discardQuarantinedCommand(quarantine)
    } catch (error) {
      // Why: the new command is already registered; leave legacy cleanup for a later attempt.
      console.warn(
        `[cli] Could not remove the legacy command at ${commandPath}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  protected async quarantineCommandPath(commandPath: string): Promise<CommandQuarantine> {
    return quarantineCommandPath(commandPath)
  }

  protected async linkQuarantinedCommand(heldPath: string, commandPath: string): Promise<void> {
    await link(heldPath, commandPath)
  }

  protected isManagedLegacyLinuxTarget(resolvedTarget: string, launcherPath: string): boolean {
    const legacyLauncherPath = resolve(dirname(launcherPath), LEGACY_LINUX_COMMAND_NAME)
    if (resolvedTarget === legacyLauncherPath) {
      return true
    }

    if (basename(resolvedTarget) !== LEGACY_LINUX_COMMAND_NAME) {
      return false
    }

    if (this.isPackagedLinuxLauncherTarget(resolvedTarget, LEGACY_LINUX_COMMAND_NAME)) {
      return true
    }

    const devLauncherDir = resolve(this.userDataPath, ...DEV_LAUNCHER_DIR)
    if (isPathInsideOrEqual(devLauncherDir, resolvedTarget)) {
      return true
    }

    const extractionOptions = this.appImageExtractionOptions()
    return extractionOptions
      ? isAppImageExtractedLauncherPath(
          extractionOptions,
          resolvedTarget,
          LEGACY_LINUX_COMMAND_NAME
        )
      : false
  }

  protected async installWindowsWrapper(commandPath: string, launcherPath: string): Promise<void> {
    await writeFile(commandPath, buildWindowsForwarder(launcherPath), 'utf8')
  }

  protected async ensureLinuxAppImagePayload(): Promise<AppImageExtractedRoot | null> {
    const extractionOptions = this.appImageExtractionOptions()
    if (!this.isLinuxAppImage() || !extractionOptions) {
      return null
    }
    const extractedRoot = await ensureAppImageExtractedRoot(extractionOptions)
    if (!extractedRoot) {
      throw new Error(
        `Could not extract the Orca AppImage at ${this.appImagePath}. Check that it is executable and that ${this.appImageCacheRootPath} has free space.`
      )
    }
    return extractedRoot
  }

  private async inspectStableSymlink(
    commandPath: string,
    launcherPath: string
  ): Promise<StableCommandInspection> {
    return inspectStableCommand(commandPath, () => this.inspectSymlink(commandPath, launcherPath))
  }

  private async inspectStableLegacyCommand(
    commandPath: string,
    launcherPath: string
  ): Promise<
    | (Pick<StableCommandInspection, 'fileSha256' | 'rawSymlinkTarget'> & {
        snapshot: NonNullable<StableCommandInspection['snapshot']>
        managed: boolean
      })
    | null
  > {
    const inspected = await inspectStableCommand(commandPath, () =>
      this.inspectSymlink(commandPath, launcherPath)
    )
    if (!inspected.snapshot) {
      return null
    }
    const resolvedTarget = inspected.rawSymlinkTarget
      ? resolve(dirname(commandPath), inspected.rawSymlinkTarget)
      : inspected.status.currentTarget
    return {
      fileSha256: inspected.fileSha256,
      rawSymlinkTarget: inspected.rawSymlinkTarget,
      snapshot: inspected.snapshot,
      managed: Boolean(
        resolvedTarget &&
        (this.isManagedLegacyLinuxTarget(resolvedTarget, launcherPath) ||
          (this.appImagePath && resolve(resolvedTarget) === resolve(this.appImagePath)))
      )
    }
  }

  private async restoreQuarantinedCommand(
    quarantine: CommandQuarantine,
    commandPath: string
  ): Promise<void> {
    await restoreQuarantinedCommand(quarantine, commandPath, (heldPath, destination) =>
      this.linkQuarantinedCommand(heldPath, destination)
    )
  }

  private async discardQuarantinedCommand(
    quarantine: CommandQuarantine,
    requireStableMetadata = true
  ): Promise<void> {
    await discardQuarantinedCommand(quarantine, requireStableMetadata)
  }

  private async installSymlinkWithPrivileges(
    commandPath: string,
    launcherPath: string,
    inspected: StableCommandInspection,
    publishTarget = launcherPath
  ): Promise<void> {
    await this.privilegedRunner(
      buildMacPrivilegedSymlinkTransaction({
        action: 'install',
        commandPath,
        launcherPath: publishTarget,
        expected: inspected.snapshot?.identity ?? null,
        expectedFileSha256: inspected.fileSha256,
        expectedRawSymlinkTarget: inspected.rawSymlinkTarget
      })
    )
    const installed = await this.inspectStableSymlink(commandPath, launcherPath)
    if (installed.status.state !== 'installed') {
      throw new Error(`Could not register the Orca command at ${commandPath}.`)
    }
  }

  private async removeSymlinkWithPrivileges(
    commandPath: string,
    inspected: StableCommandInspection
  ): Promise<void> {
    await this.privilegedRunner(
      buildMacPrivilegedSymlinkTransaction({
        action: 'remove',
        commandPath,
        expected: inspected.snapshot?.identity ?? null,
        expectedFileSha256: inspected.fileSha256,
        expectedRawSymlinkTarget: inspected.rawSymlinkTarget
      })
    )
  }
}
