import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { main } from './index'
import { completeAntigravityWorker } from './antigravity-completion'

const { constructRuntime } = vi.hoisted(() => ({
  constructRuntime: vi.fn(() => {
    throw new Error('generic RPC forbidden')
  })
}))
vi.mock('./runtime-client.js', () => ({ RuntimeClient: constructRuntime }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = undefined
})

describe('completion CLI never discovers runtime metadata or general RPC', () => {
  it('main takes completion-only fastpath with missing runtime metadata', async () => {
    const bodies: unknown[] = []
    const server = createServer((req, res) => {
      let text = ''
      req.on('data', (chunk) => {
        text += String(chunk)
      })
      req.on('end', () => {
        bodies.push(JSON.parse(text))
        res.writeHead(200).end('{"completed":true}')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('no port')
    }
    vi.stubEnv('ORCA_USER_DATA_PATH', '/missing-completion-runtime-metadata')
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main([
        'orchestration',
        'complete',
        '--dispatch-id',
        'dispatch_one',
        '--runtime-id',
        'runtime_one',
        '--endpoint',
        `http://127.0.0.1:${address.port}/hook/antigravity-completion`,
        '--dispatch-capability',
        `dcap_${'a'.repeat(43)}`,
        '--outcome',
        'succeeded',
        '--summary',
        'AGY_SMOKE_OK',
        '--json'
      ])
      expect(bodies).toEqual([
        {
          dispatchId: 'dispatch_one',
          runtimeId: 'runtime_one',
          outcome: 'succeeded',
          summary: 'AGY_SMOKE_OK'
        }
      ])
      expect(write).toHaveBeenCalledWith('{"completed":true,"retryable":false}\n')
      expect(constructRuntime).not.toHaveBeenCalled()
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
  it.each([
    'http://example.com/hook/antigravity-completion',
    'http://127.0.0.1:1234/runtime/status',
    'http://127.0.0.1:1234/hook/antigravity-completion?method=runtime.status'
  ])('rejects generic endpoint %s', async (endpoint) => {
    const flags = new Map([
      ['endpoint', endpoint],
      ['dispatch-capability', `dcap_${'a'.repeat(43)}`],
      ['dispatch-id', 'dispatch_one'],
      ['runtime-id', 'runtime_one'],
      ['outcome', 'succeeded']
    ])
    await expect(completeAntigravityWorker(flags)).rejects.toThrow('Invalid completion endpoint')
  })
})
