import { expect, it } from 'vitest'
import { readDesktopWindowState } from './desktop-window-state'

it('reports absent/destroyed, hidden, minimized, visible and focused states independently of renderer health', () => {
  const window = {
    id: 7,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => false,
    isFocused: () => false
  }
  expect(readDesktopWindowState(null)).toEqual({
    visibility: 'absent',
    minimized: false,
    windowId: null
  })
  expect(readDesktopWindowState({ ...window, isDestroyed: () => true }).visibility).toBe('absent')
  expect(readDesktopWindowState(window).visibility).toBe('hidden')
  expect(readDesktopWindowState({ ...window, isVisible: () => true }).visibility).toBe('visible')
  expect(
    readDesktopWindowState({ ...window, isVisible: () => true, isFocused: () => true }).visibility
  ).toBe('focused')
  expect(
    readDesktopWindowState({ ...window, isVisible: () => true, isMinimized: () => true })
  ).toEqual({ visibility: 'hidden', minimized: true, windowId: 7 })
})
