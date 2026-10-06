import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { antigravityConfigurationDigest } from './native-readiness-configuration'

describe('audited consumer configuration restrictions', () => {
  let home: string
  let cwd: string
  let root: string
  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'orca-agy-config-')))
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
  it('binds parent customizations without relying on a Git root cutoff', async () => {
    await mkdir(join(home, '.git'))
    await mkdir(join(home, '.agents'))
    const rules = join(home, '.agents', 'rules.md')
    await writeFile(rules, 'first rules')
    const before = await observe()
    await writeFile(rules, 'changed rules')
    expect(await observe()).not.toBe(before)
    await writeFile(rules, 'first rules')
    expect(await observe()).toBe(before)
    await writeFile(join(root, 'cache', 'projects.json'), JSON.stringify({ projects: [] }))
    expect(await observe()).not.toBe(before)
  })
  it('rejects a parent provider selector instead of ignoring inherited configuration', async () => {
    await mkdir(join(home, '.git'))
    await mkdir(join(home, '.agents'))
    await writeFile(
      join(home, '.agents', 'rules.json'),
      JSON.stringify({ nested: { model: 'other' } })
    )
    await expect(observe()).rejects.toThrow('unsupported_provider_configuration')
  })
  it('binds global legacy instructions and staged plugin content', async () => {
    const before = await observe()
    await writeFile(join(home, '.gemini', 'GEMINI.md'), 'global instructions')
    expect(await observe()).not.toBe(before)
    await rm(join(home, '.gemini', 'GEMINI.md'))
    await mkdir(join(root, 'plugins'))
    await writeFile(join(root, 'plugins', 'rules.md'), 'plugin rules')
    expect(await observe()).not.toBe(before)
  })

  it.each([
    'AGENTS.md',
    'GEMINI.md',
    '.agents/AGENTS.md',
    '.agents/GEMINI.md',
    '.agent/AGENTS.md',
    '.agent/GEMINI.md',
    '.agent/rules/legacy.md',
    '.agent/skills/legacy/SKILL.md',
    '.agents/rules/local.md',
    '.agents/skills/local/SKILL.md'
  ])('invalidates workspace and ancestor context at %s', async (relative) => {
    for (const directory of [cwd, home]) {
      const file = join(directory, relative)
      await mkdir(join(file, '..'), { recursive: true })
      const before = await observe()
      await writeFile(file, 'initial context')
      expect(await observe()).not.toBe(before)
      const initial = await observe()
      await writeFile(file, 'changed context')
      expect(await observe()).not.toBe(initial)
      await rm(file)
      expect(await observe()).toBe(before)
    }
  })
  it.each([
    'rules/native.md',
    'skills/native/SKILL.md',
    '../config/rules/shared.md',
    '../config/skills/shared/SKILL.md',
    '../config/AGENTS.md',
    '../config/GEMINI.md'
  ])('binds global context at %s', async (relative) => {
    const file = join(root, relative)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'initial context')
    const before = await observe()
    await writeFile(file, 'changed context')
    expect(await observe()).not.toBe(before)
  })
  it.each(['repository', 'worktree', 'folder'])(
    'covers ancestors consistently for %s contexts',
    async (kind) => {
      if (kind === 'repository') {
        await mkdir(join(cwd, '.git'))
      }
      if (kind === 'worktree') {
        await writeFile(join(cwd, '.git'), 'gitdir: /unread/admin/path')
      }
      const nested = join(cwd, 'sub', 'nested')
      await mkdir(nested, { recursive: true })
      const before = await antigravityConfigurationDigest(home, nested)
      for (const directory of [nested, cwd, home]) {
        const file = join(directory, 'AGENTS.md')
        await writeFile(file, 'parent context')
        expect(await antigravityConfigurationDigest(home, nested)).not.toBe(before)
        await rm(file)
      }
      expect(await antigravityConfigurationDigest(home, nested)).toBe(before)
    }
  )
  it.each(['entries', 'inherits'])(
    'binds external rules.json %s and transitive includes',
    async (field) => {
      await mkdir(join(cwd, '.agents'))
      const external = join(home, 'shared')
      await mkdir(external)
      const rule = join(external, 'rule.md')
      const included = join(home, 'included.md')
      await writeFile(included, 'initial included context')
      await writeFile(rule, '@[Shared](../included.md)')
      await writeFile(
        join(external, 'rules.json'),
        JSON.stringify({ entries: [{ path: 'rule.md' }] })
      )
      await writeFile(
        join(cwd, '.agents', 'rules.json'),
        JSON.stringify({
          [field]: [
            {
              path: field === 'inherits' ? '../../shared/rules.json' : '../../shared',
              ...(field === 'entries' ? { include_only: ['rule.md'], exclude: ['none.md'] } : {})
            }
          ]
        })
      )
      const before = await observe()
      await writeFile(included, 'changed included context')
      expect(await observe()).not.toBe(before)
      await writeFile(included, 'initial included context')
      expect(await observe()).toBe(before)
      await writeFile(rule, 'changed external rule')
      expect(await observe()).not.toBe(before)
    }
  )
  it.each(['relative', 'absolute', 'home'])('binds explicit Markdown %s includes', async (kind) => {
    const target = join(home, 'outside.md')
    await writeFile(target, 'initial')
    const path = kind === 'relative' ? '../outside.md' : kind === 'home' ? '~/outside.md' : target
    await writeFile(join(cwd, 'AGENTS.md'), `@[context](${path})`)
    const before = await observe()
    await writeFile(target, 'changed')
    expect(await observe()).not.toBe(before)
  })
  it.each([
    '@outside.md',
    '@[include]($HOME/outside.md)',
    '@[include](../missing.md)',
    '@[include](../*.md)',
    '@[include](nested(path))'
  ])('refuses ambiguous or missing reference %s', async (reference) => {
    await writeFile(join(cwd, 'AGENTS.md'), reference)
    await expect(observe()).rejects.toThrow()
  })
  it('refuses include and inheritance cycles and symlink parent escapes', async () => {
    await writeFile(join(cwd, 'AGENTS.md'), '@[self](AGENTS.md)')
    await expect(observe()).rejects.toThrow('unsupported_configuration_reference')
    await rm(join(cwd, 'AGENTS.md'))
    await mkdir(join(cwd, '.agents'))
    await writeFile(
      join(cwd, '.agents', 'rules.json'),
      JSON.stringify({ inherits: [{ path: 'rules.json' }] })
    )
    await expect(observe()).rejects.toThrow('unsupported_configuration_reference')
    await rm(join(cwd, '.agents', 'rules.json'))
    await symlink(root, join(home, 'escape'))
    await writeFile(join(cwd, 'AGENTS.md'), '@[escape](../escape/settings.json)')
    await expect(observe()).rejects.toThrow('unsupported_configuration_symlink')
  })
  it('shares byte limits with external references', async () => {
    await writeFile(join(home, 'outside.md'), Buffer.alloc(2 * 1024 * 1024 + 1))
    await writeFile(join(cwd, 'AGENTS.md'), '@[outside](../outside.md)')
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
