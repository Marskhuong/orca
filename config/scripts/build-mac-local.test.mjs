import { describe, expect, it } from 'vitest'
import { createLocalBuildVersion, getLocalMacSigningEnv } from './build-mac-local.mjs'

describe('local macOS signing environment', () => {
  it('pins native helpers to the MK identity without certificate discovery', () => {
    expect(getLocalMacSigningEnv({ CSC_NAME: 'Production certificate' })).toMatchObject({
      ORCA_MAC_LOCAL_MK: '1',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      ORCA_COMPUTER_MACOS_SIGN_IDENTITY: '-',
      ORCA_COMPUTER_MACOS_BUNDLE_ID: 'com.stablyai.orca.mk.computer-use'
    })
    expect(
      getLocalMacSigningEnv({ CSC_LINK: 'certificate.p12', CSC_NAME: 'Production' }).CSC_LINK
    ).toBeUndefined()
    expect(getLocalMacSigningEnv({ CSC_NAME: 'Production' }).CSC_NAME).toBeUndefined()
  })

  it('refuses release channel environments', () => {
    for (const key of ['ORCA_MAC_RELEASE', 'ORCA_MAC_HOURLY', 'ORCA_MAC_DAILY', 'ORCA_MAC_ADHOC']) {
      expect(() => getLocalMacSigningEnv({ [key]: '1' })).toThrow('release packaging command')
    }
  })
})

describe('createLocalBuildVersion', () => {
  it('creates unique valid prerelease versions without changing the release base', () => {
    expect(createLocalBuildVersion('1.4.159-rc.0', 123456, 'abc123')).toBe(
      '1.4.159-rc.0.local.123456.abc123'
    )
    expect(createLocalBuildVersion('1.4.159', 123456, 'abc123')).toBe('1.4.159-local.123456.abc123')
  })

  it('sanitizes commit identifiers', () => {
    expect(createLocalBuildVersion('1.0.0', 1, 'abc/def')).toBe('1.0.0-local.1.abcdef')
  })
})
