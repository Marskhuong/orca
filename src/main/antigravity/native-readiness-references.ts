import { lstat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, sep } from 'node:path'
import { AntigravityReadinessContextError } from './readiness-context-error'

export async function bindAntigravityContextReferences(args: {
  path: string
  value: Buffer
  referenced: boolean
  cwd: string
  referencePath: (path: string, source: string) => Promise<string>
  visit: (path: string, required?: boolean) => Promise<void>
}): Promise<void> {
  const { path, value, referenced, cwd, referencePath, visit } = args
  if (basename(path) === 'rules.json') {
    const manifest: unknown = JSON.parse(value.toString('utf8'))
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      Object.keys(manifest).some((key) => key !== 'entries' && key !== 'inherits')
    ) {
      throw new AntigravityReadinessContextError('unsupported_configuration_reference')
    }
    for (const [key, items] of Object.entries(manifest)) {
      if (!Array.isArray(items)) {
        throw new AntigravityReadinessContextError('unsupported_configuration_reference')
      }
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new AntigravityReadinessContextError('unsupported_configuration_reference')
        }
        const fields: Record<string, unknown> = item
        if (
          typeof fields.path !== 'string' ||
          Object.keys(fields).some(
            (name) =>
              name !== 'path' && (key === 'inherits' || !['exclude', 'include_only'].includes(name))
          )
        ) {
          throw new AntigravityReadinessContextError('unsupported_configuration_reference')
        }
        for (const name of ['exclude', 'include_only']) {
          const filter = fields[name]
          if (
            filter !== undefined &&
            (!Array.isArray(filter) || filter.some((entry) => typeof entry !== 'string'))
          ) {
            throw new AntigravityReadinessContextError('unsupported_configuration_reference')
          }
        }
        const target = await referencePath(fields.path, path)
        if (key === 'inherits' && basename(target) !== basename(path)) {
          throw new AntigravityReadinessContextError('unsupported_configuration_reference')
        }
        // Hash the whole entry tree so filters cannot hide a changing input.
        await visit(target, true)
      }
    }
  }
  if (extname(path).toLowerCase() === '.md' || referenced) {
    const source = value.toString('utf8')
    const include = /@\[[^\]\r\n]*\]\(([^()\r\n]+)\)/g
    const remaining = source.replace(include, '')
    const ruleInput =
      referenced ||
      ['AGENTS.md', 'GEMINI.md'].includes(basename(path)) ||
      path.split(sep).includes('rules')
    if (ruleInput) {
      const bare = /(?:^|[\s("'`])@([^\s)"'`<>]+)/g
      for (const match of remaining.matchAll(bare)) {
        const token = match[1]
        const candidates = new Set<string>()
        const sources =
          isAbsolute(token) || token.startsWith('~/') ? [path] : [path, join(cwd, 'reference')]
        for (const source of sources) {
          const target = await referencePath(token, source)
          try {
            if (!(await lstat(target)).isFile()) {
              throw new AntigravityReadinessContextError('unsupported_configuration_reference')
            }
            candidates.add(target)
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
              throw error
            }
          }
        }
        if (candidates.size !== 1) {
          throw new AntigravityReadinessContextError('unsupported_configuration_reference')
        }
        for (const target of candidates) {
          await visit(target, true)
        }
      }
    }
    for (const match of source.matchAll(include)) {
      const target = await referencePath(match[1], path)
      if (!(await lstat(target)).isFile()) {
        throw new AntigravityReadinessContextError('unsupported_configuration_reference')
      }
      await visit(target, true)
    }
  }
}
