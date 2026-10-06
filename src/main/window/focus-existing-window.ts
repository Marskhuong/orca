import type { App, BrowserWindow } from 'electron'
import {
  isBackgroundLaunch,
  isWindowlessLaunch,
  showWindowWithoutStealingFocus
} from './foreground-activation-policy'

type FocusTimer = (callback: () => void, ms: number) => unknown

export type FocusExistingMainWindowResult = 'focused' | 'opened' | 'pending'

export type FocusExistingMainWindowOptions = {
  app: Pick<App, 'focus' | 'isReady'> &
    Partial<Pick<App, 'setActivationPolicy'>> & { dock?: Pick<NonNullable<App['dock']>, 'show'> }
  getWindow: () => BrowserWindow | null
  openWindow: () => BrowserWindow
  /** False while some other path must own the first window; the reopen is dropped, not queued. */
  canOpenWindow?: () => boolean
  userInitiated?: boolean
  platform?: NodeJS.Platform
  setTimeout?: FocusTimer
  warn?: (message: string, error?: unknown) => void
}

function safelyFocusApp(app: Pick<App, 'focus'>, userInitiated = false): void {
  // Why: stealing the foreground is the whole point of this path for a real
  // second-instance launch, and exactly what an automated run must never do.
  if (isBackgroundLaunch() && !userInitiated) {
    return
  }
  try {
    app.focus({ steal: true })
  } catch {
    try {
      app.focus()
    } catch {
      // Best-effort; BrowserWindow focus below may still work.
    }
  }
}

export function safelyRevealWindow(window: BrowserWindow, userInitiated = false): void {
  if (window.isDestroyed() || (isWindowlessLaunch() && !userInitiated)) {
    return
  }
  if (window.isMinimized()) {
    window.restore()
  }
  if (userInitiated) {
    window.show()
  } else {
    showWindowWithoutStealingFocus(window)
  }
  if (userInitiated || !isBackgroundLaunch()) {
    window.focus()
  }
}

function pulseAlwaysOnTop(window: BrowserWindow, setTimer: FocusTimer): void {
  if (window.isDestroyed() || window.isAlwaysOnTop()) {
    return
  }

  try {
    window.setAlwaysOnTop(true)
  } catch {
    return
  }

  setTimer(() => {
    if (!window.isDestroyed()) {
      window.setAlwaysOnTop(false)
    }
  }, 250)
}

function retryFocus(window: BrowserWindow, app: Pick<App, 'focus'>, setTimer: FocusTimer): void {
  setTimer(() => {
    if (window.isDestroyed()) {
      return
    }
    safelyFocusApp(app)
    safelyRevealWindow(window)
  }, 100)
}

// Why: shared so the sync success path and the async retry/adopt callback can't
// drift on win32 reinforcement (moveTop/pulseAlwaysOnTop) or the 100ms focus retry.
function activateWindow(
  window: BrowserWindow,
  app: FocusExistingMainWindowOptions['app'],
  platform: NodeJS.Platform,
  setTimer: FocusTimer,
  userInitiated = false
): void {
  const macUserReopen = platform === 'darwin' && userInitiated
  if (macUserReopen) {
    app.setActivationPolicy?.('regular')
    void app.dock?.show().catch(() => undefined)
  }
  safelyFocusApp(app, macUserReopen)
  safelyRevealWindow(window, macUserReopen)
  // Why: moveTop/always-on-top/refocus are foreground reinforcement; in a
  // background launch they would drag the window over the developer's work.
  if (platform === 'win32' && !isBackgroundLaunch()) {
    try {
      window.moveTop()
    } catch {
      // Older Electron versions or destroyed windows may reject this; focus retry remains.
    }
    pulseAlwaysOnTop(window, setTimer)
    retryFocus(window, app, setTimer)
  }
}

// Why: a second-instance/activate reopen can race transient startup pressure
// (e.g. GPU/process churn right after another launch attempt exits); one
// swallowed throw would otherwise strand the app with no window until some
// later external trigger happens to retry.
const REOPEN_MAX_ATTEMPTS = 3
const REOPEN_RETRY_DELAY_MS = 300

function openWindowWithRetry(
  opts: Pick<
    FocusExistingMainWindowOptions,
    'app' | 'getWindow' | 'openWindow' | 'warn' | 'userInitiated'
  >,
  platform: NodeJS.Platform,
  setTimer: FocusTimer,
  attempt: number
): BrowserWindow | null {
  try {
    return opts.openWindow()
  } catch (error) {
    opts.warn?.('[window] Failed to reopen main window for second-instance launch', error)
    if (attempt >= REOPEN_MAX_ATTEMPTS) {
      return null
    }
    setTimer(() => {
      // Why: openWindow() (openMainWindow) is not idempotent — it constructs and
      // registers a fresh BrowserWindow on every call. Between attempts another
      // path (or a first attempt that threw after creating its window) may have
      // produced a live window, so adopt it instead of opening a duplicate that
      // would orphan the one already on screen.
      const existing = opts.getWindow()
      const window =
        existing && !existing.isDestroyed()
          ? existing
          : openWindowWithRetry(opts, platform, setTimer, attempt + 1)
      if (window) {
        activateWindow(window, opts.app, platform, setTimer, opts.userInitiated)
      }
    }, REOPEN_RETRY_DELAY_MS)
    return null
  }
}

export function focusExistingMainWindow(
  opts: FocusExistingMainWindowOptions
): FocusExistingMainWindowResult {
  const platform = opts.platform ?? process.platform
  const setTimer = opts.setTimeout ?? setTimeout
  let window = opts.getWindow()
  let openedWindow = false

  if (!window || window.isDestroyed()) {
    if (!opts.app.isReady() || opts.canOpenWindow?.() === false) {
      return 'pending'
    }
    window = openWindowWithRetry(opts, platform, setTimer, 1)
    if (!window) {
      return 'pending'
    }
    openedWindow = true
  }

  activateWindow(window, opts.app, platform, setTimer, opts.userInitiated)
  return openedWindow ? 'opened' : 'focused'
}
