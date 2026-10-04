import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'
import { buildNativeAntigravityReadinessLaunchCommand } from './native-readiness-launch-command'

const nativeIt = process.platform === 'win32' ? it.skip : it

describe('secret-safe native AGY environment transport', () => {
  nativeIt(
    'preserves Orca authority only in the fake child environment and strips provider overrides',
    async () => {
      const secret = 'sentinel-launch-authority'
      const child = `${quoteStartupArg(process.execPath, 'posix')} -e ${quoteStartupArg('process.stdout.write(JSON.stringify({env:process.env,argv:process.argv}))', 'posix')}`
      const command = buildNativeAntigravityReadinessLaunchCommand(child, {
        HOME: '/pinned-home',
        PATH: '/usr/bin:/bin'
      })
      expect(command).not.toContain(secret)
      const result = await runProcess({
        program: '/bin/bash',
        args: ['--noprofile', '--norc', '-p', '-c', command],
        env: {
          ORCA_AGENT_LAUNCH_TOKEN: secret,
          ORCA_PANE_KEY: 'pane',
          ORCA_AGENT_HOOK_TOKEN: 'sentinel-hook-authority',
          ORCA_UNRELATED: 'discard',
          CONDUCTOR_X: 'discard',
          ORCA_WORKSPACE_ROOT: '/folder',
          GEMINI_API_KEY: 'discard',
          CLOUD_CODE_URL: 'discard',
          HTTPS_PROXY: 'discard',
          BASH_ENV: '/must-not-be-read'
        },
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      const observed = JSON.parse(result.stdout)
      expect(observed.env).toMatchObject({
        ORCA_AGENT_LAUNCH_TOKEN: secret,
        ORCA_PANE_KEY: 'pane',
        ORCA_WORKSPACE_ROOT: '/folder',
        HOME: '/pinned-home',
        PATH: '/usr/bin:/bin'
      })
      expect(observed.env).not.toHaveProperty('ORCA_UNRELATED')
      expect(observed.env).not.toHaveProperty('CONDUCTOR_X')
      expect(observed.env.ORCA_AGENT_HOOK_TOKEN).toBe('sentinel-hook-authority')
      expect(JSON.stringify(observed.argv)).not.toContain('sentinel-hook-authority')
      expect(observed.env).not.toHaveProperty('GEMINI_API_KEY')
      expect(observed.env).not.toHaveProperty('CLOUD_CODE_URL')
      expect(observed.env).not.toHaveProperty('HTTPS_PROXY')
      expect(observed.env).not.toHaveProperty('BASH_ENV')
      expect(JSON.stringify(observed.argv)).not.toContain(secret)
    }
  )

  nativeIt.each(['A-B', 'A\nB', 'BASH_FUNC_exec%%', 'SHELLOPTS'])(
    'refuses unfilterable inherited names before the child: %s',
    async (name) => {
      const command = buildNativeAntigravityReadinessLaunchCommand('/usr/bin/true', {})
      const result = await runProcess({
        program: '/bin/bash',
        args: ['--noprofile', '--norc', '-p', '-c', command],
        env: { [name]: 'hostile' },
        timeoutMs: 5000
      })
      expect(result.code).toBe(125)
    }
  )

  nativeIt('pins the actual child cwd independently of the outer shell', async () => {
    const child = `${quoteStartupArg(process.execPath, 'posix')} -e ${quoteStartupArg('process.stdout.write(process.cwd())', 'posix')}`
    const command = buildNativeAntigravityReadinessLaunchCommand(child, {}, '/tmp')
    const result = await runProcess({
      program: '/bin/bash',
      cwd: '/',
      args: ['--noprofile', '--norc', '-p', '-c', command],
      env: {},
      timeoutMs: 5000
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/\/(?:private\/)?tmp$/)
  })

  nativeIt('does not invent absent Orca authority and quotes fixed env data', async () => {
    const child = `${quoteStartupArg(process.execPath, 'posix')} -e ${quoteStartupArg('process.stdout.write(JSON.stringify(process.env))', 'posix')}`
    const value = "literal ' $(exit 92) space"
    const command = buildNativeAntigravityReadinessLaunchCommand(child, { HOME: value })
    const result = await runProcess({
      program: '/bin/bash',
      args: ['--noprofile', '--norc', '-p', '-c', command],
      env: {},
      timeoutMs: 5000
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ HOME: value })
    expect(JSON.parse(result.stdout)).not.toHaveProperty('ORCA_AGENT_LAUNCH_TOKEN')
  })
})
