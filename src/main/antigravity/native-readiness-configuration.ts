import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

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
        throw new Error('unsupported_provider_configuration')
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
  const root = join(home, '.gemini', 'antigravity-cli')
  if (
    (await namesOrAbsent(root)).some((name) => name.endsWith('-oauth-token')) ||
    (await namesOrAbsent(join(root, 'cache'))).some((name) => name.endsWith('-keyring-unavailable'))
  ) {
    throw new Error('unsupported_credential_storage')
  }
  const hash = createHash('sha256')
  let bytes = 0
  let entries = 0
  async function visit(path: string): Promise<void> {
    if (++entries > 512) {
      throw new Error('configuration_limit')
    }
    hash.update(JSON.stringify(path))
    let stat
    try {
      stat = await lstat(path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        hash.update('absent')
        return
      }
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new Error('unsupported_configuration_symlink')
    }
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name))
      }
    } else if (stat.isFile()) {
      bytes += stat.size
      if (bytes > MAX_CONFIG_BYTES) {
        throw new Error('configuration_limit')
      }
      const value = await readFile(path)
      if (value.length !== stat.size) {
        throw new Error('identity_changed')
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
            throw new Error('unsupported_settings')
          }
        }
        assertNoProviderSelectors(parsed)
      } else if (
        extname(path) === '.pbtxt' &&
        /\b(?:model_provider|custom_model|endpoint|gateway|api_key)\s*:/i.test(
          value.toString('utf8')
        )
      ) {
        throw new Error('unsupported_provider_configuration')
      }
      hash.update(value)
    } else {
      throw new Error('unsupported_configuration_file')
    }
  }
  for (const path of [
    join(root, 'settings.json'),
    join(root, 'jetski_state.pbtxt'),
    join(root, 'cache', 'onboarding.json'),
    join(root, 'cache', 'default_project_id.txt'),
    join(home, '.gemini', 'config'),
    join(cwd, '.agents'),
    join(cwd, '.gemini')
  ]) {
    await visit(path)
  }
  return hash.digest('hex')
}
