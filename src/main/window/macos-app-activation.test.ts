import { expect, it, vi } from 'vitest'
import { createMacAppActivationHandler } from './macos-app-activation'

it('routes every native user reopen through the shared activation gate, even with a live hidden window', () => {
  const requestActivation = vi.fn()
  const handler = createMacAppActivationHandler({ requestActivation })
  handler()
  handler()
  expect(requestActivation).toHaveBeenCalledTimes(2)
})
