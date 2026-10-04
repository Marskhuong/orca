import { describe, expect, it, vi } from 'vitest'
import { runProcess } from './run-process'
import * as processTree from './process-tree-termination'

const posixIt = process.platform === 'win32' ? it.skip : it
const childScript = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: process.env.KEEP_PIPES === '1' ? ['ignore', 'inherit', 'inherit'] : 'ignore'
  });
  child.unref();
  process.stdout.write(String(child.pid));
  if (process.env.KEEP_ROOT === '1') setTimeout(() => {}, 30000);
`

describe('opt-in owned process-group cleanup', () => {
  posixIt.each([false, true])(
    'quiesces redirected descendants after timeout=%s',
    async (timeout) => {
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', childScript],
        env: { KEEP_ROOT: timeout ? '1' : '0' },
        detached: true,
        terminationBarrier: true,
        quiesceGroupOnClose: true,
        timeoutMs: timeout ? 2000 : 5000
      })
      const pid = Number(result.stdout)
      expect(pid).toBeGreaterThan(0)
      try {
        expect(result.processGroupQuiescent).toBe(true)
        expect(result.timedOut).toBe(timeout)
        if (!timeout) {
          expect(result.code).toBe(0)
        }
        const observation = await runProcess({
          program: '/bin/ps',
          args: ['-p', String(pid), '-o', 'stat='],
          timeoutMs: 1000
        })
        expect(observation.code !== 0 || observation.stdout.trim().startsWith('Z')).toBe(true)
      } finally {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* Already quiescent. */
        }
      }
    }
  )

  posixIt(
    'does not accept a successful root while a descendant holds its output pipes',
    async () => {
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', childScript],
        env: { KEEP_PIPES: '1' },
        detached: true,
        terminationBarrier: true,
        quiesceGroupOnClose: true,
        timeoutMs: 2000
      })
      expect(Number(result.stdout)).toBeGreaterThan(0)
      expect(result).toMatchObject({ timedOut: true, processGroupQuiescent: true })
    }
  )

  posixIt('fails closed when the deadline lands during normal-exit cleanup', async () => {
    const quiesce = processTree.quiesceExitedProcessGroup
    const delayedForce = vi
      .spyOn(processTree, 'quiesceExitedProcessGroup')
      .mockImplementation(async (child) => {
        await new Promise<void>((done) => setTimeout(done, 1500))
        return quiesce(child)
      })
    try {
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', childScript],
        detached: true,
        terminationBarrier: true,
        quiesceGroupOnClose: true,
        timeoutMs: 1000
      })
      expect(Number(result.stdout)).toBeGreaterThan(0)
      expect(result.timedOut).toBe(true)
    } finally {
      delayedForce.mockRestore()
    }
  })

  it('refuses cleanup of a group the caller does not own before spawning', async () => {
    await expect(
      runProcess({
        program: process.execPath,
        args: ['-e', 'process.exit(92)'],
        quiesceGroupOnClose: true,
        terminationBarrier: true
      })
    ).rejects.toThrow('detached POSIX termination barrier')
  })

  it('leaves ordinary process-result semantics unchanged', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("ok")']
    })
    expect(result).toMatchObject({ code: 0, stdout: 'ok', timedOut: false })
    expect(result).not.toHaveProperty('processGroupQuiescent')
  })

  it('refuses to replace a caller-supplied termination barrier', async () => {
    await expect(
      runProcess({
        program: process.execPath,
        detached: true,
        quiesceGroupOnClose: true,
        terminationBarrier: { signal: async () => true, force: async () => true }
      })
    ).rejects.toThrow('detached POSIX termination barrier')
  })
})
