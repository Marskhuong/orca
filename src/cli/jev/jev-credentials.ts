import { runProcess } from '../../shared/child-process/run-process'

export async function readJevCredential(env = process.env): Promise<string | null> {
  if (env.TYPESAFE_API_KEY?.trim()) {
    return env.TYPESAFE_API_KEY.trim()
  }
  if (process.platform !== 'darwin') {
    return null
  }
  const result = await runProcess({
    program: '/usr/bin/security',
    args: [
      'find-generic-password',
      '-s',
      env.ORCA_JEV_KEYCHAIN_SERVICE ?? 'Orca MK JEV API',
      '-a',
      env.ORCA_JEV_KEYCHAIN_ACCOUNT ?? 'JEV_API_KEY',
      '-w'
    ],
    timeoutMs: 3000,
    maxOutputBytes: 4096
  }).catch(() => null)
  return result?.code === 0 && !result.timedOut && !result.outputTruncated
    ? result.stdout.trim() || null
    : null
}
