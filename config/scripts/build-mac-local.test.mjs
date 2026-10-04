import { describe, expect, it } from 'vitest'
import {
  createLocalBuildVersion,
  getLocalMacSigningEnv,
  verifyLocalMacSigningIdentity
} from './build-mac-local.mjs'

const fingerprint = 'A'.repeat(40)
const localIdentityEnv = { ORCA_MAC_LOCAL_SIGN_IDENTITY: fingerprint }

describe('local macOS signing environment', () => {
  it('pins native helpers to the MK identity without certificate discovery', () => {
    expect(
      getLocalMacSigningEnv({ ...localIdentityEnv, CSC_NAME: 'Production certificate' })
    ).toMatchObject({
      ORCA_MAC_LOCAL_MK: '1',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      ORCA_COMPUTER_MACOS_SIGN_IDENTITY: fingerprint,
      ORCA_COMPUTER_MACOS_BUNDLE_ID: 'com.stablyai.orca.mk.computer-use'
    })
    expect(
      getLocalMacSigningEnv({
        ...localIdentityEnv,
        CSC_LINK: 'certificate.p12',
        CSC_NAME: 'Production'
      }).CSC_LINK
    ).toBeUndefined()
    expect(
      getLocalMacSigningEnv({ ...localIdentityEnv, CSC_NAME: 'Production' }).CSC_NAME
    ).toBeUndefined()
    expect(
      getLocalMacSigningEnv({ ...localIdentityEnv, CSC_KEYCHAIN: 'production.keychain' })
        .CSC_KEYCHAIN
    ).toBeUndefined()
  })

  it('refuses missing or ad-hoc signing identities', () => {
    expect(() => getLocalMacSigningEnv({})).toThrow('ORCA_MAC_LOCAL_SIGN_IDENTITY')
    expect(() => getLocalMacSigningEnv({ ORCA_MAC_LOCAL_SIGN_IDENTITY: '-' })).toThrow('SHA-1')
  })

  it('rejects production or unavailable identities', () => {
    for (const name of [
      'Developer ID Application: Lovecast LLC',
      'Apple Development: Lovecast',
      'Apple Distribution: Other'
    ]) {
      expect(() =>
        verifyLocalMacSigningIdentity(fingerprint, `1) ${fingerprint} "${name}"`)
      ).toThrow('local development')
    }
    expect(() => verifyLocalMacSigningIdentity(fingerprint, '0 valid identities found')).toThrow(
      'private key'
    )
    expect(
      verifyLocalMacSigningIdentity(fingerprint, `1) ${fingerprint} "Apple Development: Local"`)
    ).toBe('Apple Development: Local')
    expect(
      verifyLocalMacSigningIdentity(fingerprint, `1) ${fingerprint} "Orca MK Local Development"`)
    ).toBe('Orca MK Local Development')
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
