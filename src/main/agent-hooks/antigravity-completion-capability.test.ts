import { describe, expect, it, vi } from 'vitest'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import {
  issueAntigravityCompletion,
  redeemAntigravityCompletion,
  handleAntigravityCompletionHttp,
  ANTIGRAVITY_COMPLETION_TTL_MS,
  ANTIGRAVITY_COMPLETION_PATH
} from './antigravity-completion-capability'

const report = { dispatchId: 'dispatch_one', runtimeId: 'runtime_one', outcome: 'succeeded' }
function grant(complete = vi.fn()) {
  return {
    token: issueAntigravityCompletion({ ...report, complete, now: 100, monotonicNow: 100 }),
    complete
  }
}

describe('one-shot AGY completion authority', () => {
  it('authenticates exact dispatch and consumes before a second call', () => {
    const { token, complete } = grant()
    redeemAntigravityCompletion(token, report, 101, 101)
    expect(complete).toHaveBeenCalledExactlyOnceWith(report)
    expect(() => redeemAntigravityCompletion(token, report, 102, 102)).toThrow()
    expect(complete).toHaveBeenCalledTimes(1)
  })
  it.each(['dispatchId', 'runtimeId'])('rejects wrong %s and forged tokens', (field) => {
    const { token, complete } = grant()
    expect(() =>
      redeemAntigravityCompletion(token, { ...report, [field]: 'other' }, 101, 101)
    ).toThrow()
    expect(() => redeemAntigravityCompletion('forged', report, 101, 101)).toThrow()
    expect(complete).not.toHaveBeenCalled()
  })
  it.each(['wall', 'monotonic'])('rejects expired %s authority', (clock) => {
    const { token, complete } = grant()
    const expired = 100 + ANTIGRAVITY_COMPLETION_TTL_MS
    expect(() =>
      redeemAntigravityCompletion(
        token,
        report,
        clock === 'wall' ? expired : 101,
        clock === 'monotonic' ? expired : 101
      )
    ).toThrow()
    expect(complete).not.toHaveBeenCalled()
  })
  it('loses issued authority when module/process state is restarted', async () => {
    const { token } = grant()
    vi.resetModules()
    const restarted = await import('./antigravity-completion-capability')
    expect(() => restarted.redeemAntigravityCompletion(token, report, 101, 101)).toThrow()
  })
  it.each([
    { ...report, method: 'runtime.status' },
    { ...report, outcome: 'READY' },
    { ...report, summary: 'x'.repeat(2049) }
  ])('rejects broader/malformed operations', (body) => {
    const { token, complete } = grant()
    expect(() => redeemAntigravityCompletion(token, body, 101, 101)).toThrow()
    expect(complete).not.toHaveBeenCalled()
  })
  it('does not restore authority after an ambiguous settlement exception', () => {
    const { token, complete } = grant(
      vi.fn(() => {
        throw new Error('commit uncertainty')
      })
    )
    expect(() => redeemAntigravityCompletion(token, report, 101, 101)).toThrow()
    expect(() => redeemAntigravityCompletion(token, report, 102, 102)).toThrow()
    expect(complete).toHaveBeenCalledTimes(1)
  })
  it('listener restricts capability to POST completion, never reads metadata', async () => {
    const complete = vi.fn()
    const token = issueAntigravityCompletion({ ...report, complete })
    const server = createServer((req, res) => {
      void handleAntigravityCompletionHttp(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(403).end()
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('missing address')
    }
    const send = (path: string, method: string, payload = report) =>
      new Promise<number | undefined>((resolve, reject) => {
        const body = JSON.stringify(payload)
        const req = request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path,
            method,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              'X-Orca-Completion-Token': token
            }
          },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode))
          }
        )
        req.on('error', reject)
        req.end(body)
      })
    try {
      expect(await send('/runtime/status', 'GET')).toBe(403)
      expect(await send(ANTIGRAVITY_COMPLETION_PATH, 'GET')).toBe(403)
      expect(await send(ANTIGRAVITY_COMPLETION_PATH, 'POST')).toBe(200)
      expect(await send(ANTIGRAVITY_COMPLETION_PATH, 'POST')).toBe(403)
      expect(complete).toHaveBeenCalledTimes(1)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
