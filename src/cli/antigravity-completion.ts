import { request } from 'node:http'
import { getRequiredStringFlag, getOptionalStringFlag } from './flags'

export async function completeAntigravityWorker(
  flags: Map<string, string | boolean>
): Promise<void> {
  const endpoint = new URL(getRequiredStringFlag(flags, 'endpoint'))
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.pathname !== '/hook/antigravity-completion' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.port
  ) {
    throw new Error('Invalid completion endpoint')
  }
  const token = getRequiredStringFlag(flags, 'dispatch-capability')
  if (!/^dcap_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('Invalid completion capability')
  }
  const outcome = getRequiredStringFlag(flags, 'outcome')
  if (outcome !== 'succeeded' && outcome !== 'failed') {
    throw new Error('Invalid completion outcome')
  }
  const summary = getOptionalStringFlag(flags, 'summary')
  if (summary && summary.length > 2048) {
    throw new Error('Completion summary is too long')
  }
  const body = JSON.stringify({
    dispatchId: getRequiredStringFlag(flags, 'dispatch-id'),
    runtimeId: getRequiredStringFlag(flags, 'runtime-id'),
    outcome,
    ...(summary ? { summary } : {})
  })
  await new Promise<void>((resolve, reject) => {
    const req = request(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Orca-Completion-Token': token
        }
      },
      (res) => {
        let result = ''
        res.on('data', (chunk: Buffer) => {
          result += chunk.toString()
          if (result.length > 1024) {
            req.destroy(new Error('Invalid completion response'))
          }
        })
        res.on('end', () => {
          if (res.statusCode !== 200 || result !== '{"completed":true}') {
            reject(new Error('Completion refused; do not retry automatically'))
          } else {
            resolve()
          }
        })
        res.on('error', reject)
      }
    )
    const timer = setTimeout(
      () => req.destroy(new Error('Completion timed out; outcome unknown; do not retry')),
      5000
    )
    req.on('close', () => clearTimeout(timer))
    req.on('error', () =>
      reject(new Error('Completion unavailable; outcome unknown; do not retry'))
    )
    req.end(body)
  })
  process.stdout.write('{"completed":true,"retryable":false}\n')
}
