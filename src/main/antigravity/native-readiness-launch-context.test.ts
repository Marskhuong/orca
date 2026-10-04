import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AntigravityNativeCredential } from './native-credential-codec'

const fixture = vi.hoisted<{
  home: string
  credential: AntigravityNativeCredential | null
  selected: string
}>(() => ({ home: '', credential: null, selected: '' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.home, isPackaged: () => false })
}))
vi.mock('../ipc/command-path-resolver', () => ({
  resolveCommandOnLocalPath: async () => join(fixture.home, 'agy')
}))
vi.mock('./native-credential-backend', () => ({
  createAntigravityHostCredentialBackend: () => ({ read: async () => fixture.credential })
}))
vi.mock('./native-account-store', () => ({
  createEncryptedAntigravityAccountStore: () => ({
    read: () => ({
      selectedAccountId: fixture.selected,
      accounts: fixture.selected
        ? [{ id: fixture.selected, subject: 'other', authMethod: 'consumer' }]
        : []
    })
  })
}))
import { resolveNativeAntigravityReadinessContext } from './native-readiness-launch-context'

const digest = '7dca095cfc1df2c057a385ed88a76c7ba98dc103258a80be87a8f42e484cb3aa'
function credential(access = 'access'): AntigravityNativeCredential {
  return {
    authMethod: 'consumer',
    identity: { issuer: 'https://accounts.google.com', subject: 'same-account', email: null },
    contents: JSON.stringify({
      auth_method: 'consumer',
      token: { access_token: access, refresh_token: 'refresh' }
    })
  }
}
describe('native bound AGY launch context', () => {
  beforeEach(async () => {
    fixture.home = await mkdtemp(join(tmpdir(), 'orca-agy-identity-'))
    await writeFile(join(fixture.home, 'agy'), 'fake executable, never launched')
    fixture.credential = credential()
    fixture.selected = ''
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(fixture.home, { recursive: true, force: true })
  })
  function args() {
    return {
      runId: 'run',
      generation: 1,
      runtimeEpoch: 'runtime',
      worktreeId: 'folder',
      cwd: fixture.home,
      home: fixture.home,
      vaultPath: join(fixture.home, 'vault'),
      settings: { agentCmdOverrides: {} },
      env: {}
    }
  }
  const observe = () => resolveNativeAntigravityReadinessContext(args(), async () => digest)

  it('permits the same-account token refresh and ordinary macOS SSH agent socket', async () => {
    const before = await observe()
    fixture.credential = credential('refreshed')
    const after = await resolveNativeAntigravityReadinessContext(
      { ...args(), env: { SSH_AUTH_SOCK: '/launchd/socket' } },
      async () => digest
    )
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after.command).not.toContain('refresh')
    expect(after.command).toContain('/bin/bash')
  })

  it.each([
    { agentDefaultArgs: { antigravity: '--gateway' } },
    { agentCmdOverrides: { antigravity: 'wrapper' } },
    { agentDefaultEnv: { antigravity: { GEMINI_API_KEY: 'secret' } } },
    { httpProxyUrl: 'http://proxy' }
  ])('refuses unpinned launcher settings %j', async (settings) => {
    await expect(
      resolveNativeAntigravityReadinessContext(
        { ...args(), settings: { ...args().settings, ...settings } },
        async () => digest
      )
    ).rejects.toThrow()
  })
  it.each([
    'SSH_CONNECTION',
    'WSL_DISTRO_NAME',
    'GEMINI_API_KEY',
    'ANTIGRAVITY_AUTH_URL',
    'CLOUD_CODE_URL',
    'HTTPS_PROXY'
  ])('refuses alternate execution or provider selector %s', async (name) => {
    await expect(
      resolveNativeAntigravityReadinessContext(
        { ...args(), env: { [name]: 'unsupported' } },
        async () => digest
      )
    ).rejects.toThrow()
  })
  it('refuses missing auth, a selected-account mismatch and an unaudited executable', async () => {
    fixture.credential = null
    await expect(observe()).rejects.toThrow()
    fixture.credential = credential()
    fixture.selected = 'other'
    await expect(observe()).rejects.toThrow()
    fixture.selected = ''
    await expect(
      resolveNativeAntigravityReadinessContext(args(), async () => 'changed')
    ).rejects.toThrow()
  })
  it('binds runtime, Run generation, target, and configuration', async () => {
    const before = await observe()
    for (const changed of [
      { runtimeEpoch: 'other' },
      { generation: 2 },
      { runId: 'other' },
      { worktreeId: 'other' }
    ]) {
      expect(
        (
          await resolveNativeAntigravityReadinessContext(
            { ...args(), ...changed },
            async () => digest
          )
        ).fingerprint
      ).not.toBe(before.fingerprint)
    }
    await mkdir(join(fixture.home, '.agents'))
    await writeFile(join(fixture.home, '.agents', 'instructions.md'), 'changed configuration')
    expect((await observe()).fingerprint).not.toBe(before.fingerprint)
  })
})
