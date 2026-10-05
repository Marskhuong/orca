import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { readJevCredential } from './jev-credentials'
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(runProcess).mockReset()
})
describe('Jev execution-host credentials', () => {
  it('uses an explicit environment key without Keychain access', async () => {
    expect(await readJevCredential({ TYPESAFE_API_KEY: ' test-secret ' })).toBe('test-secret')
    expect(runProcess).not.toHaveBeenCalled()
  })
  it('reads the existing default Keychain item on macOS only', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'test-secret\n',
      stderr: '',
      timedOut: false
    })
    expect(await readJevCredential({})).toBe('test-secret')
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/bin/security',
        args: ['find-generic-password', '-s', 'Orca MK JEV API', '-a', 'JEV_API_KEY', '-w'],
        timeoutMs: 3000,
        maxOutputBytes: 4096
      })
    )
  })
  it.each(['linux', 'win32'] as const)('does not invoke macOS Keychain on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(await readJevCredential({})).toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })
  it('does not accept timed-out or truncated credential capture', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'test-secret',
      stderr: '',
      timedOut: true
    })
    expect(await readJevCredential({})).toBeNull()
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'test-secret',
      stderr: '',
      timedOut: false,
      outputTruncated: true
    })
    expect(await readJevCredential({})).toBeNull()
  })
})
