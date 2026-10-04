const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const IDENTITY_FILENAME = 'orca-build-identity.json'
const PROVENANCE_FILENAME = 'orca-artifact-build.json'

function sourceIdentity(projectDir = process.cwd(), env = process.env) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: 'pipe'
    }).trim()
  const protocol = readFileSync(join(projectDir, 'src/shared/protocol-version.ts'), 'utf8')
  let commit
  try {
    commit = git(['rev-parse', 'HEAD'])
  } catch (error) {
    if (env.ORCA_MAC_LOCAL_MK === '1') {
      throw new Error('MK builds require Git source provenance', { cause: error })
    }
    commit = 'unknown'
  }
  const hash = createHash('sha256').update(commit)
  const scopes = [
    'src',
    'config',
    'resources',
    'package.json',
    'electron.vite.config.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'native',
    'patches'
  ]
  if (commit !== 'unknown') {
    hash.update(git(['diff', 'HEAD', '--binary', '--', ...scopes]))
    for (const file of git(['ls-files', '--others', '--exclude-standard', '--', ...scopes])
      .split('\n')
      .filter(Boolean)
      .sort()) {
      hash.update(file).update(readFileSync(join(projectDir, file)))
    }
  } else {
    hash.update(protocol).update(readFileSync(join(projectDir, 'package.json')))
  }
  const value = (name) => {
    const match = protocol.match(new RegExp(`export const ${name} = (\\d+)`))
    if (!match) {
      throw new Error(`Missing protocol constant ${name}`)
    }
    return Number(match[1])
  }
  return {
    distribution: env.ORCA_MAC_LOCAL_MK === '1' ? 'orca-mk' : 'orca',
    version:
      env.ORCA_LOCAL_BUILD_VERSION ||
      JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).version,
    commit,
    sourceFingerprint: hash.digest('hex'),
    runtimeProtocolVersion: value('RUNTIME_PROTOCOL_VERSION'),
    minCompatibleRuntimeClientVersion: value('MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION'),
    minCompatibleRuntimeServerVersion: value('MIN_COMPATIBLE_RUNTIME_SERVER_VERSION')
  }
}

function artifactDigest(directory) {
  const hash = createHash('sha256')
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const name = prefix + entry.name
      if (entry.isDirectory()) {
        visit(join(dir, entry.name), `${name}/`)
      } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        hash.update(name).update(readFileSync(join(dir, entry.name)))
      }
    }
  }
  visit(directory)
  return hash.digest('hex')
}

function recordArtifactBuild(
  kind,
  projectDir = process.cwd(),
  identity = sourceIdentity(projectDir)
) {
  const directory = join(projectDir, 'out', kind)
  if (!statSync(join(directory, 'index.js')).isFile()) {
    throw new Error(`Missing ${kind} entry`)
  }
  const receipt = {
    ...identity,
    artifactDigest: artifactDigest(directory),
    ...(kind === 'cli' ? { sharedDigest: artifactDigest(join(projectDir, 'out/shared')) } : {})
  }
  writeFileSync(join(directory, PROVENANCE_FILENAME), `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
}

function verifyBuildPair(outDir, expected) {
  const receipts = ['cli', 'main'].map((kind) => {
    const directory = join(outDir, kind)
    const receipt = JSON.parse(readFileSync(join(directory, PROVENANCE_FILENAME), 'utf8'))
    if (receipt.artifactDigest !== artifactDigest(directory)) {
      throw new Error(`Bundled ${kind} artifact changed after build`)
    }
    if (kind === 'cli' && receipt.sharedDigest !== artifactDigest(join(outDir, 'shared'))) {
      throw new Error('CLI shared modules changed after build')
    }
    return receipt
  })
  for (const key of Object.keys(expected)) {
    if (receipts.some((receipt) => receipt[key] !== expected[key])) {
      throw new Error(`CLI/runtime build mismatch: ${key}; rebuild both from the same source`)
    }
  }
  return expected
}

function verifyPackagedCli(resourcesDir, expected, platform = process.platform) {
  const outDir = join(resourcesDir, 'app.asar.unpacked', 'out')
  const cli = JSON.parse(readFileSync(join(outDir, 'cli', PROVENANCE_FILENAME), 'utf8'))
  for (const key of Object.keys(expected)) {
    if (cli[key] !== expected[key]) {
      throw new Error(`Packaged CLI/runtime build mismatch: ${key}`)
    }
  }
  if (cli.sharedDigest !== artifactDigest(join(outDir, 'shared'))) {
    throw new Error('Packaged CLI shared modules changed')
  }
  if (cli.artifactDigest !== artifactDigest(join(outDir, 'cli'))) {
    throw new Error('Packaged CLI artifact changed')
  }
  const launcher = join(
    resourcesDir,
    'bin',
    platform === 'win32' ? 'orca.exe' : platform === 'linux' ? 'orca-ide' : 'orca'
  )
  const stats = statSync(launcher)
  if (!stats.isFile() || stats.size === 0 || (platform !== 'win32' && (stats.mode & 0o111) === 0)) {
    throw new Error('Packaged CLI launcher is missing or not executable')
  }
  writeFileSync(join(resourcesDir, IDENTITY_FILENAME), `${JSON.stringify(expected, null, 2)}\n`)
}

module.exports = {
  IDENTITY_FILENAME,
  PROVENANCE_FILENAME,
  sourceIdentity,
  artifactDigest,
  recordArtifactBuild,
  verifyBuildPair,
  verifyPackagedCli
}

if (require.main === module) {
  const projectDir = resolve('.')
  const identity = sourceIdentity(projectDir)
  const startPath = join(projectDir, 'out', 'orca-cli-build-start.json')
  if (process.argv[2] === 'begin-cli') {
    mkdirSync(join(projectDir, 'out'), { recursive: true })
    writeFileSync(startPath, JSON.stringify(identity))
  } else if (process.argv[2] === 'cli') {
    if (JSON.stringify(JSON.parse(readFileSync(startPath, 'utf8'))) !== JSON.stringify(identity)) {
      throw new Error('Source changed during CLI build; rebuild CLI and runtime')
    }
    recordArtifactBuild('cli', projectDir, identity)
  } else {
    throw new Error('Expected begin-cli or cli build phase')
  }
}
