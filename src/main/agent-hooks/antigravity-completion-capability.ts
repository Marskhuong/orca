import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { readRequestBody } from '../../shared/agent-hook-listener/request-body'

export const ANTIGRAVITY_COMPLETION_PATH = '/hook/antigravity-completion'
export const ANTIGRAVITY_COMPLETION_TTL_MS = 5 * 60_000
const Completion = z
  .object({
    dispatchId: z.string().min(1).max(128),
    runtimeId: z.string().min(1).max(128),
    outcome: z.enum(['succeeded', 'failed']),
    summary: z.string().max(2048).optional()
  })
  .strict()
export type AntigravityCompletion = z.infer<typeof Completion>
type Grant = {
  dispatchId: string
  runtimeId: string
  expiresAt: number
  monotonicExpiry: number
  complete: (report: AntigravityCompletion) => void
}
const grants = new Map<string, Grant>()
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

export function issueAntigravityCompletion(args: {
  dispatchId: string
  runtimeId: string
  complete: Grant['complete']
  now?: number
  monotonicNow?: number
}): string {
  const now = args.now ?? Date.now()
  const monotonicNow = args.monotonicNow ?? performance.now()
  for (const [key, grant] of grants) {
    if (now >= grant.expiresAt || monotonicNow >= grant.monotonicExpiry) {
      grants.delete(key)
    }
  }
  if (grants.size >= 512) {
    throw new Error('completion_capacity_exhausted')
  }
  const token = `dcap_${randomBytes(32).toString('base64url')}`
  grants.set(digest(token), {
    dispatchId: args.dispatchId,
    runtimeId: args.runtimeId,
    complete: args.complete,
    expiresAt: now + ANTIGRAVITY_COMPLETION_TTL_MS,
    monotonicExpiry: monotonicNow + ANTIGRAVITY_COMPLETION_TTL_MS
  })
  return token
}

export function redeemAntigravityCompletion(
  token: string,
  body: unknown,
  now = Date.now(),
  monotonicNow = performance.now()
): void {
  const key = digest(token)
  const grant = grants.get(key)
  if (!grant || now >= grant.expiresAt || monotonicNow >= grant.monotonicExpiry) {
    grants.delete(key)
    throw new Error('completion_capability_invalid')
  }
  const report = Completion.parse(body)
  if (report.dispatchId !== grant.dispatchId || report.runtimeId !== grant.runtimeId) {
    throw new Error('completion_identity_mismatch')
  }
  // Consume before entering canonical settlement; ambiguous failure never restores authority.
  grants.delete(key)
  grant.complete(report)
}

export async function handleAntigravityCompletionHttp(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (req.url !== ANTIGRAVITY_COMPLETION_PATH) {
    return false
  }
  const token = req.headers['x-orca-completion-token']
  if (req.method !== 'POST' || typeof token !== 'string' || !grants.has(digest(token))) {
    res.writeHead(403).end()
    return true
  }
  const timer = setTimeout(() => req.destroy(), 5000)
  try {
    const length = req.headers['content-length']
    if (
      req.headers['content-type'] !== 'application/json' ||
      typeof length !== 'string' ||
      !/^[0-9]+$/.test(length) ||
      Number(length) < 1 ||
      Number(length) > 8192 ||
      req.headers['transfer-encoding']
    ) {
      throw new Error('invalid_completion')
    }
    const body = await readRequestBody(req)
    redeemAntigravityCompletion(token, body)
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ completed: true }))
  } catch {
    if (!res.destroyed) {
      res.writeHead(403).end(JSON.stringify({ completed: false, retryable: false }))
    }
  }
  clearTimeout(timer)
  return true
}
