import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { antigravityConfigurationDigest } from './native-readiness-configuration'

describe('audited consumer configuration restrictions', () => {
  let home: string
  let cwd: string
  let root: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-agy-config-'))
    cwd = join(home, 'workspace')
    root = join(home, '.gemini', 'antigravity-cli')
    await mkdir(join(root, 'cache'), { recursive: true })
    await mkdir(cwd)
  })
  afterEach(async () => rm(home, { recursive: true, force: true }))
  const observe = () => antigravityConfigurationDigest(home, cwd)

  it('allows only the audited settings roots, including terminal sandbox', async () => {
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        agentMode: 'planning',
        allowNonWorkspaceAccess: false,
        colorScheme: 'dark',
        enableTerminalSandbox: true,
        permissions: {},
        toolPermission: {},
        trustedWorkspaces: []
      })
    )
    await expect(observe()).resolves.toMatch(/^[a-f0-9]{64}$/)
  })
  it.each([
    { customModels: [] },
    { modelProvider: 'other' },
    { permissions: { gatewayEndpoint: 'other' } },
    { newUnknownKey: true }
  ])('rejects unsupported settings %j', async (settings) => {
    await writeFile(join(root, 'settings.json'), JSON.stringify(settings))
    await expect(observe()).rejects.toThrow()
  })
  it.each([
    'antigravity-oauth-token',
    'gemini-oauth-token',
    'cache/antigravity-keyring-unavailable'
  ])('refuses alternate credential store marker %s', async (path) => {
    await writeFile(join(root, ...path.split('/')), '')
    await expect(observe()).rejects.toThrow('unsupported_credential_storage')
  })
  it('rejects provider-shaped workspace configuration and malformed JSON', async () => {
    await mkdir(join(cwd, '.agents'))
    await writeFile(
      join(cwd, '.agents', 'config.json'),
      JSON.stringify({ nested: { model: 'collision' } })
    )
    await expect(observe()).rejects.toThrow()
    await writeFile(join(cwd, '.agents', 'config.json'), '{broken')
    await expect(observe()).rejects.toThrow()
  })
  it('rejects symlinks and oversized configuration without following them', async () => {
    await symlink(cwd, join(root, 'settings.json'))
    await expect(observe()).rejects.toThrow()
    await rm(join(root, 'settings.json'))
    await writeFile(join(root, 'jetski_state.pbtxt'), Buffer.alloc(2 * 1024 * 1024 + 1))
    await expect(observe()).rejects.toThrow('configuration_limit')
  })
  it('allows only the exact empty global optional MCP file and rejects nonempty malformed data', async () => {
    const config = join(home, '.gemini', 'config')
    await mkdir(config)
    const mcp = join(config, 'mcp_config.json')
    await writeFile(mcp, '')
    await expect(observe()).resolves.toMatch(/^[a-f0-9]{64}$/)
    await writeFile(mcp, '{broken')
    await expect(observe()).rejects.toThrow()
    await writeFile(mcp, '')
    await writeFile(join(root, 'settings.json'), '')
    await expect(observe()).rejects.toThrow()
  })
})
