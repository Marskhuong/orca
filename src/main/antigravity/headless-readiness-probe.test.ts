import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/run-process'
import { probeAntigravityHeadlessReadiness } from './headless-readiness-probe'

const captured = readFileSync(join(__dirname, '__fixtures__', 'headless-ready.ndjson'), 'utf8')
const success: ProcessResult = {
  code: 0,
  signal: null,
  stdout: captured,
  stderr: '',
  processGroupQuiescent: true,
  timedOut: false
}
const target = { program: '/audited/agy', cwd: '<workspace>', env: { HOME: '/native-home' } }

describe('bounded Antigravity inference observation', () => {
  it('runs one exact-model inference through the process-tree wrapper', async () => {
    const run = vi.fn(async () => success)
    await expect(probeAntigravityHeadlessReadiness({ ...target, run })).resolves.toMatchObject({
      readiness: 'READY'
    })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/bin/bash',
        cwd: target.cwd,
        env: target.env,
        args: expect.arrayContaining(['--noprofile', '--norc', '-p', '-c']),
        timeoutMs: 35_000,
        maxOutputBytes: 65_536,
        killOnOutputLimit: true,
        detached: process.platform !== 'win32',
        terminationBarrier: true
      })
    )
  })

  it.each<Partial<ProcessResult>>([
    { timedOut: true },
    { processGroupQuiescent: false },
    { processGroupQuiescent: undefined },
    { outputTruncated: true },
    { code: 1 },
    { signal: 'SIGTERM' },
    { stderr: 'Authentication required' },
    { stderr: 'Warning: returning partial output' },
    { stdout: '' }
  ])('does not retry or accept ambiguous process results: %j', async (change) => {
    const run = vi.fn(async () => ({ ...success, ...change }))
    const result = await probeAntigravityHeadlessReadiness({ ...target, run })
    expect(result.readiness).toBe('UNKNOWN')
    expect(run).toHaveBeenCalledOnce()
  })

  it('rejects abort even if the runner reports a successful prior root exit', async () => {
    const controller = new AbortController()
    const run = vi.fn(async () => {
      controller.abort()
      return success
    })
    expect(
      (await probeAntigravityHeadlessReadiness({ ...target, run, signal: controller.signal }))
        .readiness
    ).toBe('UNKNOWN')
  })

  it('does not start an already aborted observation', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = vi.fn(async () => success)
    expect(
      (await probeAntigravityHeadlessReadiness({ ...target, run, signal: controller.signal }))
        .readiness
    ).toBe('UNKNOWN')
    expect(run).not.toHaveBeenCalled()
  })

  it('does not expose process failures or credential-bearing diagnostics', async () => {
    const run = vi.fn(async () => {
      throw new Error('secret-access-token')
    })
    const result = await probeAntigravityHeadlessReadiness({ ...target, run })
    expect(result.readiness).toBe('UNKNOWN')
    expect(JSON.stringify(result)).not.toContain('secret-access-token')
  })
})
