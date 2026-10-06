import { AntigravityReadinessContextError } from './readiness-context-error'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, extname, dirname, basename, resolve, isAbsolute } from 'node:path'
import { bindAntigravityContextReferences } from './native-readiness-references'

const SETTINGS_KEYS = new Set([
  'agentMode',
  'allowNonWorkspaceAccess',
  'colorScheme',
  'enableTerminalSandbox',
  'permissions',
  'toolPermission',
  'trustedWorkspaces'
])
const MAX_CONFIG_BYTES = 2 * 1024 * 1024

function assertNoProviderSelectors(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoProviderSelectors(item)
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (/model|provider|endpoint|gateway|api.?key|auth.?url/i.test(key)) {
        throw new AntigravityReadinessContextError('unsupported_provider_configuration')
      }
      assertNoProviderSelectors(nested)
    }
  }
}

async function namesOrAbsent(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export async function antigravityConfigurationDigest(home: string, cwd: string): Promise<string> {
  home = await realpath(home)
  cwd = await realpath(cwd)
  const root = join(home, '.gemini', 'antigravity-cli')
  if (
    (await namesOrAbsent(root)).some((name) => name.endsWith('-oauth-token')) ||
    (await namesOrAbsent(join(root, 'cache'))).some((name) => name.endsWith('-keyring-unavailable'))
  ) {
    throw new AntigravityReadinessContextError('unsupported_credential_storage')
  }
  const hash = createHash('sha256')
  let bytes = 0
  let entries = 0
  const completed = new Set<string>()
  const active = new Set<string>()
  async function referencePath(path: string, source: string): Promise<string> {
    if (
      !path ||
      /[\\\r\n\0*?${}<>]/.test(path) ||
      (path.startsWith('~') && !path.startsWith('~/'))
    ) {
      throw new AntigravityReadinessContextError('unsupported_configuration_reference')
    }
    const target = path.startsWith('~/')
      ? resolve(home, path.slice(2))
      : resolve(dirname(source), path)
    let parent = target
    for (let depth = 0; ; depth++) {
      if (depth >= 64) {
        throw new AntigravityReadinessContextError('configuration_limit')
      }
      try {
        if ((await lstat(parent)).isSymbolicLink()) {
          throw new AntigravityReadinessContextError('unsupported_configuration_symlink')
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
      const next = dirname(parent)
      if (next === parent) {
        break
      }
      parent = next
    }
    return target
  }
  async function visit(path: string, required = false): Promise<void> {
    if (!isAbsolute(path)) {
      throw new AntigravityReadinessContextError('unsupported_context')
    }
    if (active.has(path)) {
      throw new AntigravityReadinessContextError('unsupported_configuration_reference')
    }
    const key = `${required ? 'referenced' : 'context'}:${path}`
    if (completed.has(key)) {
      return
    }
    if (active.size >= 32) {
      throw new AntigravityReadinessContextError('configuration_limit')
    }
    active.add(path)
    await referencePath(path, path)
    if (++entries > 512) {
      throw new AntigravityReadinessContextError('configuration_limit')
    }
    hash.update(JSON.stringify(path))
    let stat
    try {
      stat = await lstat(path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        if (required) {
          throw new AntigravityReadinessContextError('unsupported_configuration_reference')
        }
        hash.update('absent')
        active.delete(path)
        completed.add(key)
        return
      }
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new AntigravityReadinessContextError('unsupported_configuration_symlink')
    }
    if (stat.isDirectory()) {
      const names = (await readdir(path)).sort()
      if (names.length > 512) {
        throw new AntigravityReadinessContextError('configuration_limit')
      }
      if (!required && basename(path) === 'skills') {
        for (const name of names) {
          const directory = join(path, name)
          const child = await lstat(directory)
          if (child.isSymbolicLink()) {
            throw new AntigravityReadinessContextError('unsupported_configuration_symlink')
          }
          if (child.isDirectory()) {
            await visit(join(directory, 'SKILL.md'))
          }
        }
      } else {
        for (const name of names) {
          await visit(join(path, name), required)
        }
      }
    } else if (stat.isFile()) {
      bytes += stat.size
      if (bytes > MAX_CONFIG_BYTES) {
        throw new AntigravityReadinessContextError('configuration_limit')
      }
      const value = await readFile(path)
      if (value.length !== stat.size) {
        throw new AntigravityReadinessContextError('identity_changed')
      }
      const emptyOptionalMcp =
        path === join(home, '.gemini', 'config', 'mcp_config.json') && value.length === 0
      if (extname(path) === '.json' && !emptyOptionalMcp) {
        const parsed: unknown = JSON.parse(value.toString('utf8'))
        if (path === join(root, 'settings.json')) {
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed) ||
            Object.keys(parsed).some((key) => !SETTINGS_KEYS.has(key))
          ) {
            throw new AntigravityReadinessContextError('unsupported_settings')
          }
        }
        assertNoProviderSelectors(parsed)
      } else if (
        extname(path) === '.pbtxt' &&
        /\b(?:model_provider|custom_model|endpoint|gateway|api_key)\s*:/i.test(
          value.toString('utf8')
        )
      ) {
        throw new AntigravityReadinessContextError('unsupported_provider_configuration')
      }
      await bindAntigravityContextReferences({
        path,
        value,
        referenced: required,
        cwd,
        referencePath,
        visit
      })
      hash.update(value)
    } else {
      throw new AntigravityReadinessContextError('unsupported_configuration_file')
    }
    active.delete(path)
    completed.add(key)
  }
  for (const path of [
    join(root, 'settings.json'),
    join(root, 'jetski_state.pbtxt'),
    join(root, 'cache', 'onboarding.json'),
    join(root, 'cache', 'default_project_id.txt'),
    join(root, 'cache', 'projects.json'),
    join(root, 'plugins'),
    join(root, 'rules'),
    join(root, 'rules.json'),
    join(root, 'skills'),
    join(root, 'hooks.json'),
    join(home, '.gemini', 'config'),
    join(home, '.gemini', 'GEMINI.md'),
    join(home, '.gemini', 'AGENTS.md')
  ]) {
    await visit(path)
  }
  let directory = resolve(cwd)
  for (let depth = 0; ; depth++) {
    if (depth >= 64) {
      throw new AntigravityReadinessContextError('configuration_limit')
    }
    await referencePath(directory, join(directory, 'context'))
    for (const name of ['AGENTS.md', 'GEMINI.md', '.agents', '.agent']) {
      await visit(join(directory, name))
    }
    if (directory !== home || directory === cwd) {
      await visit(join(directory, '.gemini'))
    }
    const parent = dirname(directory)
    if (parent === directory) {
      break
    }
    directory = parent
  }
  return hash.digest('hex')
}
