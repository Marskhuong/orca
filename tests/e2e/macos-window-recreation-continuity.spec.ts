import { test, expect } from './helpers/orca-app'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type {
  RuntimeStatus,
  RuntimeTerminalCreate,
  RuntimeTerminalRead,
  RuntimeTerminalSummary
} from '../../src/shared/runtime-types'

test.use({ launchEnv: { ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1' } })

test('macOS explicit reopen preserves a real managed PTY through window recreation', async ({
  electronApp,
  orcaPage,
  seededRepoPath
}) => {
  // Native focus is opt-in on an explicitly authorized macOS acceptance display.
  test.skip(process.platform !== 'darwin' || process.env.ORCA_MACOS_REOPEN_ACCEPTANCE !== '1')
  expect(
    await electronApp.evaluate(({ app }) => ({
      enforced: process.env.ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK,
      listeners: app.listenerCount('second-instance')
    }))
  ).toEqual({ enforced: '1', listeners: 1 })

  async function secondInstance(background: boolean): Promise<void> {
    const handled = await electronApp.evaluate(({ app }, backgroundLaunch) => {
      if (app.listenerCount('second-instance') !== 1) {
        throw new Error('Production singleton listener is missing or duplicated')
      }
      return app.emit('second-instance', {}, [], '', { orcaBackgroundLaunch: backgroundLaunch })
    }, background)
    expect(handled).toBe(true)
  }

  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userData, 10_000)
  const before = (await client.call<RuntimeStatus>('status.get')).result
  const pid = electronApp.process().pid
  const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: `path:${seededRepoPath}`,
    title: 'Window continuity proof'
  })
  const terminal = created.result.terminal
  expect(terminal.ptyId).toBeTruthy()
  expect(terminal.incarnationId).toBeTruthy()
  const oldWindow = await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { id: window.id, rendererId: window.webContents.id }
  })

  async function proveTerminal(marker: string): Promise<void> {
    await client.call('terminal.send', {
      terminal: terminal.handle,
      text: `echo ${marker}`,
      enter: true
    })
    await expect
      .poll(async () => {
        const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
          terminal: terminal.handle,
          limit: 100
        })
        return read.result.terminal.tail.join('\n')
      })
      .toContain(marker)
    const listed = await client.call<{ terminals: RuntimeTerminalSummary[] }>('terminal.list')
    expect(listed.result.terminals.find((entry) => entry.handle === terminal.handle)).toMatchObject(
      {
        ptyId: terminal.ptyId,
        incarnationId: terminal.incarnationId,
        connected: true,
        writable: true
      }
    )
    expect((await client.call<RuntimeStatus>('status.get')).result.runtimeId).toBe(before.runtimeId)
    expect(electronApp.process().pid).toBe(pid)
  }

  await proveTerminal('WINDOW_CONTINUITY_BEFORE')
  expect(before.desktopWindowState?.visibility).toBe('hidden')
  await secondInstance(true)
  await electronApp.evaluate(({ BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused())) {
      throw new Error('Background singleton invocation revealed a window')
    }
  })
  // A native reopen reaches the installed activation gate and the real window actions.
  await electronApp.evaluate(({ app }) => app.emit('activate'))
  await expect
    .poll(
      async () =>
        (await client.call<RuntimeStatus>('status.get')).result.desktopWindowState?.visibility
    )
    .toBe('focused')
  expect(await orcaPage.evaluate(() => window.api.ui.isMaximized())).toBe(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMaximized()
    )
  )

  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
  await expect
    .poll(
      async () =>
        (await client.call<RuntimeStatus>('status.get')).result.desktopWindowState?.minimized
    )
    .toBe(true)
  await electronApp.evaluate(({ app }) => app.emit('activate'))
  await expect
    .poll(async () => (await client.call<RuntimeStatus>('status.get')).result.desktopWindowState)
    .toMatchObject({ visibility: 'focused', minimized: false, windowId: oldWindow.id })
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await electronApp.evaluate(({ app }) => app.emit('activate'))
  await expect
    .poll(
      async () =>
        (await client.call<RuntimeStatus>('status.get')).result.desktopWindowState?.visibility
    )
    .toBe('focused')

  // Destroy the actual window; its production closed listeners dispose/rebind IPC services.
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy())
  await expect
    .poll(
      async () =>
        (await client.call<RuntimeStatus>('status.get')).result.desktopWindowState?.visibility
    )
    .toBe('absent')
  await proveTerminal('WINDOW_CONTINUITY_ABSENT')
  await secondInstance(true)
  await electronApp.evaluate(({ BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().length !== 0) {
      throw new Error('Background invocation created a window')
    }
  })
  const replacementPromise = electronApp.waitForEvent('window')
  await secondInstance(false)
  const replacement = await replacementPromise
  await replacement.waitForLoadState('domcontentloaded')
  await replacement.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await expect
    .poll(
      async () =>
        (await client.call<RuntimeStatus>('status.get')).result.desktopWindowState?.visibility
    )
    .toBe('focused')
  const identity = await electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    return { count: windows.length, id: windows[0].id, rendererId: windows[0].webContents.id }
  })
  expect(identity.count).toBe(1)
  expect(identity.id).not.toBe(oldWindow.id)
  expect(identity.rendererId).not.toBe(oldWindow.rendererId)
  expect((await client.call<RuntimeStatus>('status.get')).result.authoritativeWindowId).toBe(
    identity.id
  )
  expect(await replacement.evaluate(() => window.api.ui.isMaximized())).toBe(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMaximized()
    )
  )
  await proveTerminal('WINDOW_CONTINUITY_AFTER')
})
