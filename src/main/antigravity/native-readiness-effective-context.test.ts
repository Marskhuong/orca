import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { antigravityConfigurationDigest } from './native-readiness-configuration'

let home: string
let cwd: string
let skill: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'orca-agy-effective-')))
  cwd = join(home, 'workspace')
  skill = join(home, '.agents/skills/example')
  await mkdir(cwd)
  await mkdir(skill, { recursive: true })
})
afterEach(async () => rm(home, { recursive: true, force: true }))
const digest = () => antigravityConfigurationDigest(home, cwd)
async function file(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

it('does not interpret skill package selectors, CSS directives, emails or examples as bare references', async () => {
  await file(
    join(skill, 'SKILL.md'),
    [
      '---\nname: example\ndescription: sample\n---',
      '```sh\nnpx skills add vercel-labs/agent-skills@react-best-practices\n```',
      '```css\n@media (min-width: 600px) {}\n```',
      'Contact person@example.com; example: @not-a-rule-file'
    ].join('\n')
  )
  await expect(digest()).resolves.toMatch(/^[a-f0-9]{64}$/)
})

it('ignores unreferenced helper trees larger than the unchanged 2 MiB cap', async () => {
  await file(join(skill, 'SKILL.md'), 'skill instructions')
  const before = await digest()
  await file(join(skill, 'scripts/live/instructions.mjs'), Buffer.alloc(2 * 1024 * 1024 + 1))
  expect(await digest()).toBe(before)
  await file(join(skill, 'scripts/live/instructions.mjs'), 'changed helper')
  expect(await digest()).toBe(before)
  await file(join(skill, 'SKILL.md'), 'changed instructions')
  expect(await digest()).not.toBe(before)
})

it.each(['AGENTS.md', '.agents/rules/example.md'])(
  'binds a genuine bare reference from %s',
  async (input) => {
    await file(join(cwd, input), '@context.txt')
    await file(join(cwd, 'context.txt'), 'initial effective context')
    const before = await digest()
    await file(join(cwd, 'context.txt'), 'changed effective context')
    expect(await digest()).not.toBe(before)
  }
)

it.each(['include', 'manifest'])(
  'binds an explicitly referenced skill helper through %s',
  async (mechanism) => {
    const helper = join(skill, 'scripts/context.txt')
    await file(helper, 'initial effective helper')
    await file(
      join(skill, 'SKILL.md'),
      mechanism === 'include' ? '@[context](scripts/context.txt)' : 'instructions'
    )
    if (mechanism === 'manifest') {
      await file(
        join(home, '.agents/rules.json'),
        JSON.stringify({ entries: [{ path: 'skills/example/scripts/context.txt' }] })
      )
    }
    const before = await digest()
    await file(helper, 'changed effective helper')
    expect(await digest()).not.toBe(before)
    await file(helper, Buffer.alloc(2 * 1024 * 1024 + 1))
    await expect(digest()).rejects.toThrow('configuration_limit')
  }
)

it('rejects ambiguous bare reference resolution', async () => {
  await file(join(cwd, '.agents/rules/example.md'), '@context.txt')
  await file(join(cwd, '.agents/rules/context.txt'), 'file-relative')
  await file(join(cwd, 'context.txt'), 'workspace-relative')
  await expect(digest()).rejects.toThrow('unsupported_configuration_reference')
})

it('rejects missing references, cycles and symlink escapes in effective context', async () => {
  await file(join(cwd, 'AGENTS.md'), '@context.md')
  await expect(digest()).rejects.toThrow('unsupported_configuration_reference')
  await file(join(cwd, 'context.md'), '@AGENTS.md')
  await expect(digest()).rejects.toThrow('unsupported_configuration_reference')
  await rm(join(cwd, 'context.md'))
  await file(join(home, 'outside.md'), 'outside')
  await symlink(join(home, 'outside.md'), join(cwd, 'context.md'))
  await expect(digest()).rejects.toThrow('unsupported_configuration_symlink')
})
