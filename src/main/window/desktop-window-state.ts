import type { BrowserWindow } from 'electron'
import type { RuntimeDesktopWindowState } from '../../shared/runtime-types'

export function readDesktopWindowState(
  window: Pick<
    BrowserWindow,
    'id' | 'isDestroyed' | 'isMinimized' | 'isVisible' | 'isFocused'
  > | null
): RuntimeDesktopWindowState {
  if (!window || window.isDestroyed()) {
    return { visibility: 'absent', minimized: false, windowId: null }
  }
  const minimized = window.isMinimized()
  return {
    visibility:
      !window.isVisible() || minimized ? 'hidden' : window.isFocused() ? 'focused' : 'visible',
    minimized,
    windowId: window.id
  }
}
