import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JEV_HANDLERS } from './jev'
import { readJevCredential } from '../jev/jev-credentials'
vi.mock('../jev/jev-credentials', () => ({ readJevCredential: vi.fn() }))
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-jev-cli-'))
  vi.stubEnv('ORCA_JEV_USAGE_DIRECTORY', join(directory, 'usage'))
  vi.mocked(readJevCredential).mockResolvedValue('test-secret')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.mocked(readJevCredential).mockReset()
  process.exitCode = 0
  await rm(directory, { recursive: true, force: true })
})
describe('Jev CLI structured interface', () => {
  it.each(['lead', 'worker'])(
    'works in %s terminal context without accessing runtime or dispatch APIs',
    async (role) => {
      vi.stubEnv('ORCA_TERMINAL_HANDLE', `term_${role}`)
      vi.stubEnv('ORCA_ORCHESTRATION_RUN_ID', 'run_test')
      vi.stubEnv('ORCA_ORCHESTRATION_DISPATCH_ID', role === 'worker' ? 'dispatch_test' : '')
      const path = join(directory, 'input.json')
      await writeFile(
        path,
        JSON.stringify({
          state: 'Lamp is on.',
          questions: [{ type: 'noul', instructions: 'Is the lamp on?' }]
        })
      )
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          model: 'jev-1.13.0',
          answers: { q0: { type: 'noul', noul: 1 } },
          usage: { input_tokens: 9, output_tokens: 1 }
        })
      )
      vi.stubGlobal('fetch', fetcher)
      const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      await JEV_HANDLERS['jev decide']({
        flags: new Map([['input', path]]),
        get client(): never {
          throw new Error('runtime access forbidden')
        },
        cwd: directory,
        json: false
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      const raw = String(output.mock.calls[0][0])
      expect(JSON.parse(raw)).toMatchObject({
        status: 'succeeded',
        accounting: { status: 'recorded' }
      })
      expect(raw).not.toContain('test-secret')
    }
  )
  it.each(['environment', 'pairing-code'])(
    'rejects explicit remote selection %s without credentials or network',
    async (flag) => {
      const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      const fetcher = vi.fn<typeof fetch>()
      vi.stubGlobal('fetch', fetcher)
      await JEV_HANDLERS['jev decide']({
        flags: new Map([[flag, 'remote']]),
        get client(): never {
          throw new Error('runtime access forbidden')
        },
        cwd: directory,
        json: true
      })
      expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
        status: 'failed',
        retryable: false
      })
      expect(readJevCredential).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it.each(['{', '{"state":false,"questions":[]}'])(
    'rejects malformed input %s before reading a credential',
    async (content) => {
      const path = join(directory, 'bad.json')
      await writeFile(path, content)
      const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      await JEV_HANDLERS['jev decide']({
        flags: new Map([['input', path]]),
        get client(): never {
          throw new Error('runtime access forbidden')
        },
        cwd: directory,
        json: false
      })
      expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
        status: 'failed',
        retryable: false,
        durationMs: expect.any(Number)
      })
      expect(readJevCredential).not.toHaveBeenCalled()
    }
  )
  it('reports empty local accounting without runtime access', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await JEV_HANDLERS['jev usage']({
      flags: new Map(),
      get client(): never {
        throw new Error('runtime access forbidden')
      },
      cwd: directory,
      json: false
    })
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
      calls: 0,
      balance: 'NOT_AUTOMATED'
    })
    expect(readJevCredential).not.toHaveBeenCalled()
  })
})
