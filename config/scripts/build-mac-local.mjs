import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const LOCAL_MAC_APP_ID = 'com.stablyai.orca.mk'

export function getLocalMacSigningEnv(env = process.env) {
  if (
    ['ORCA_MAC_RELEASE', 'ORCA_MAC_HOURLY', 'ORCA_MAC_DAILY', 'ORCA_MAC_ADHOC'].some(
      (key) => env[key] === '1'
    )
  ) {
    throw new Error('Use the release packaging command for signed release channels.')
  }
  const signingIdentity = env.ORCA_MAC_LOCAL_SIGN_IDENTITY?.trim().toUpperCase()
  if (!signingIdentity || !/^[0-9A-F]{40}$/.test(signingIdentity)) {
    throw new Error('Set ORCA_MAC_LOCAL_SIGN_IDENTITY to a local development certificate SHA-1.')
  }
  const localEnv = {
    ...env,
    ORCA_MAC_LOCAL_MK: '1',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    ORCA_MAC_LOCAL_SIGN_IDENTITY: signingIdentity,
    ORCA_COMPUTER_MACOS_SIGN_IDENTITY: signingIdentity,
    ORCA_COMPUTER_MACOS_BUNDLE_ID: `${LOCAL_MAC_APP_ID}.computer-use`
  }
  for (const key of [
    'CSC_LINK',
    'CSC_NAME',
    'CSC_KEYCHAIN',
    'CSC_KEY_PASSWORD',
    'CSC_INSTALLER_LINK',
    'CSC_INSTALLER_KEY_PASSWORD'
  ]) {
    delete localEnv[key]
  }
  return localEnv
}

export function verifyLocalMacSigningIdentity(fingerprint, identities) {
  const match = [...identities.matchAll(/\b([0-9A-F]{40})\s+"([^"]+)"/g)].find(
    (entry) => entry[1] === fingerprint
  )
  if (
    !match ||
    /Lovecast/i.test(match[2]) ||
    !(match[2].startsWith('Apple Development:') || match[2] === 'Orca MK Local Development')
  ) {
    throw new Error(
      'The selected identity must be an available local development identity with a private key.'
    )
  }
  return match[2]
}

export function createLocalBuildVersion(baseVersion, timestamp, commit) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(baseVersion)) {
    throw new Error(`Package version is not valid semver: ${baseVersion}`)
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('Local build timestamp is invalid.')
  }
  const sanitizedCommit = commit.replace(/[^0-9A-Za-z-]/g, '').slice(0, 12)
  if (!sanitizedCommit) {
    throw new Error('Git commit identity is empty.')
  }
  const suffix = `local.${timestamp}.${sanitizedCommit}`
  return baseVersion.includes('-') ? `${baseVersion}.${suffix}` : `${baseVersion}-${suffix}`
}

export function getLocalBuildIdentity() {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  return {
    commit,
    version: createLocalBuildVersion(packageJson.version, Date.now(), commit)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getLocalBuildIdentity()
  const env = {
    ...getLocalMacSigningEnv(),
    ORCA_BUILD_COMMIT: identity.commit,
    ORCA_LOCAL_BUILD_VERSION: identity.version
  }
  const signingName = verifyLocalMacSigningIdentity(
    env.ORCA_MAC_LOCAL_SIGN_IDENTITY,
    execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  )
  console.log(
    `[build:mac] local signing identity ${signingName} (${env.ORCA_MAC_LOCAL_SIGN_IDENTITY})`
  )
  console.log(`[build:mac] local update version ${identity.version}`)
  for (const [script, ...args] of [
    ['build-computer-macos.mjs'],
    ['build-keyboard-layout-macos.mjs'],
    ['build-notification-status-macos.mjs', '--bundle-id', LOCAL_MAC_APP_ID]
  ]) {
    execFileSync(process.execPath, [resolve('config/scripts', script), ...args], {
      env,
      stdio: 'inherit'
    })
  }
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    [
      'exec',
      'electron-builder',
      '--config',
      'config/electron-builder.config.cjs',
      '--mac',
      ...process.argv.slice(2)
    ],
    {
      env,
      stdio: 'inherit'
    }
  )
}
