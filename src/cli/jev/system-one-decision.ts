import { randomUUID } from 'node:crypto'
import { canonicalJevJson, parseJevRequest, parseJevResponse } from './system-one-contract'

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_TIMEOUT_MS = 20_000
export const JEV_MAX_BYTES = 256 * 1024
export type JevDecisionResult = Awaited<ReturnType<typeof decideWithJev>>

export async function decideWithJev(
  input: unknown,
  credential: string | null,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
) {
  const requestId = randomUUID()
  const started = performance.now()
  const failure = (code: string, uncertain = false, httpStatus?: number) => ({
    status: uncertain ? ('outcome_unknown' as const) : ('failed' as const),
    requestId,
    durationMs: Math.round(performance.now() - started),
    retryable: false as const,
    error: { code, ...(httpStatus ? { httpStatus } : {}) }
  })
  let request
  let body
  try {
    request = parseJevRequest(input)
    body = canonicalJevJson(request)
    if (Buffer.byteLength(body, 'utf8') > JEV_MAX_BYTES) {
      return failure('INVALID_REQUEST')
    }
  } catch {
    return failure('INVALID_REQUEST')
  }
  if (!credential || !credential.trim() || /[\r\n]/.test(credential)) {
    return failure('AUTH_REQUIRED')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? JEV_TIMEOUT_MS)
  try {
    const response = await (options.fetch ?? fetch)(JEV_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body
    })
    if (!response.ok) {
      return failure(
        response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : 'PROVIDER_REJECTED',
        response.status >= 500,
        response.status
      )
    }
    if (!response.body) {
      return failure('MALFORMED_RESPONSE', true)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) {
          break
        }
        size += chunk.value.byteLength
        if (size > JEV_MAX_BYTES) {
          controller.abort()
          return failure('MALFORMED_RESPONSE', true)
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    let parsed
    try {
      parsed = parseJevResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')), request)
    } catch {
      return failure('MALFORMED_OR_MISMATCHED_RESPONSE', true)
    }
    return {
      status: 'succeeded' as const,
      requestId,
      durationMs: Math.round(performance.now() - started),
      retryable: false as const,
      effectiveModel: parsed.model,
      answers: parsed.answers,
      usage: parsed.usage
    }
  } catch {
    return failure(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_OR_PROVIDER_AMBIGUITY', true)
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
