import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import {
  probeAntigravityHeadlessReadiness,
  type AntigravityReadinessObservation
} from '../../antigravity/headless-readiness-probe'
import type { NativeAntigravityReadinessContext } from '../../antigravity/native-readiness-launch-context'
import { ANTIGRAVITY_READINESS_MODEL } from '../../antigravity/headless-readiness-response'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import {
  requireRunCapacity,
  recordRunCapacity,
  requireRouteDispatchable
} from './run-capacity-state'

export const runtimeReceiptWriter = Symbol('runtime-readiness-writer')
const ANTIGRAVITY_RECEIPT_TTL_MS = 120_000
type AntigravityReceipt = AntigravityReadinessObservation & {
  generation: number
  receiptId: string
  observedAt: number
  expiresAt: number
  monotonicExpiresAt: number
  contextBinding: string
  runtimeHost: 'native:darwin'
  model: typeof ANTIGRAVITY_READINESS_MODEL
  inferenceMayConsumeTokens: true
}
const antigravityReceipts = new WeakMap<OrchestrationDb, Map<string, AntigravityReceipt>>()
const antigravityChecks = new WeakMap<OrchestrationDb, Map<string, Promise<AntigravityReceipt>>>()

export function receiptsFor(db: OrchestrationDb): Map<string, AntigravityReceipt> {
  let entries = antigravityReceipts.get(db)
  if (!entries) {
    entries = new Map()
    antigravityReceipts.set(db, entries)
  }
  return entries
}

export async function observeAntigravityRunReadiness(args: {
  db: OrchestrationDb
  runId: string
  resolveContext: () => Promise<NativeAntigravityReadinessContext>
  observe?: typeof probeAntigravityHeadlessReadiness
  now?: () => number
  monotonicNow?: () => number
}): Promise<AntigravityReceipt & { cacheHit: boolean }> {
  const now = args.now ?? Date.now
  const monotonicNow = args.monotonicNow ?? (() => performance.now())
  requireRunCapacity(args.db, args.runId)
  const run = args.db.getRunRaw(args.runId)
  if (!run) {
    throw new OrchestrationError('run_not_found', 'Run no longer exists.')
  }
  const generation = run.consumer_generation
  let context: NativeAntigravityReadinessContext
  try {
    context = await args.resolveContext()
  } catch {
    if (args.db.getRunRaw(args.runId)?.consumer_generation !== generation) {
      throw new OrchestrationError('ROUTE_NOT_READY', 'Run changed during context observation.', {
        reason: 'identity_changed',
        effectsApplied: false
      })
    }
    const current = requireRunCapacity(args.db, args.runId)
    receiptsFor(args.db).delete(args.runId)
    const route = current.RUN_ROUTING_POSTURE.routes.find(
      (entry) => entry.route_identity === 'antigravity'
    )
    if (route) {
      route.readiness = 'UNKNOWN'
      route.readiness_reason = 'unsupported_context'
      delete route.runtime_readiness_receipt_id
    }
    recordRunCapacity(args.db, args.runId, current)
    throw new OrchestrationError(
      'ROUTE_NOT_READY',
      'The requested Antigravity execution context could not be verified.',
      {
        readiness: 'UNKNOWN',
        reason: 'unsupported_context',
        effectsApplied: false,
        workerCreated: false
      }
    )
  }
  if (
    args.db.getRunRaw(args.runId)?.consumer_generation !== generation ||
    context.runId !== args.runId ||
    context.generation !== generation
  ) {
    throw new OrchestrationError(
      'ROUTE_NOT_READY',
      'Readiness context no longer belongs to the Run.',
      { reason: 'identity_changed', effectsApplied: false }
    )
  }
  const receipts = receiptsFor(args.db)
  const cached = receipts.get(args.runId)
  if (
    cached?.contextBinding === context.fingerprint &&
    cached.generation === generation &&
    !antigravityReceiptExpired(cached, now(), monotonicNow())
  ) {
    const current = requireRunCapacity(args.db, args.runId)
    const route = current.RUN_ROUTING_POSTURE.routes.find(
      (entry) => entry.route_identity === 'antigravity'
    )
    if (route) {
      route.readiness = cached.readiness
      route.readiness_reason = cached.reason
      route.runtime_readiness_receipt_id = cached.receiptId
      recordRunCapacity(args.db, args.runId, current, null, runtimeReceiptWriter)
    }
    return { ...cached, cacheHit: true }
  }
  let checks = antigravityChecks.get(args.db)
  if (!checks) {
    checks = new Map()
    antigravityChecks.set(args.db, checks)
  }
  const key = `${args.runId}:${context.fingerprint}`
  const pending = checks.get(key)
  if (pending) {
    return { ...(await pending), cacheHit: true }
  }
  const check = (async () => {
    const observation = await (args.observe ?? probeAntigravityHeadlessReadiness)(context)
    let unchanged = false
    try {
      unchanged = (await args.resolveContext()).fingerprint === context.fingerprint
    } catch {
      /* Missing identity cannot authorize allocation. */
    }
    const observedAt = now()
    const receipt: AntigravityReceipt = {
      ...(unchanged ? observation : { readiness: 'UNKNOWN' as const, reason: 'identity_changed' }),
      generation,
      receiptId: randomUUID(),
      observedAt,
      expiresAt: observedAt + ANTIGRAVITY_RECEIPT_TTL_MS,
      monotonicExpiresAt: monotonicNow() + ANTIGRAVITY_RECEIPT_TTL_MS,
      contextBinding: context.fingerprint,
      runtimeHost: 'native:darwin',
      model: ANTIGRAVITY_READINESS_MODEL,
      inferenceMayConsumeTokens: true
    }
    if (args.db.getRunRaw(args.runId)?.consumer_generation !== generation) {
      throw new OrchestrationError('ROUTE_NOT_READY', 'Run changed during readiness observation.', {
        reason: 'identity_changed',
        effectsApplied: false
      })
    }
    const current = requireRunCapacity(args.db, args.runId)
    receipts.set(args.runId, receipt)
    for (const route of current.RUN_ROUTING_POSTURE.routes) {
      if (route.route_identity !== 'antigravity') {
        continue
      }
      route.readiness = receipt.readiness
      route.readiness_reason = receipt.reason
      route.runtime_readiness_receipt_id = receipt.receiptId
    }
    recordRunCapacity(args.db, args.runId, current, null, runtimeReceiptWriter)
    return receipt
  })()
  checks.set(key, check)
  try {
    return { ...(await check), cacheHit: false }
  } finally {
    if (checks.get(key) === check) {
      checks.delete(key)
    }
  }
}

export function requireAntigravityRunReadiness(
  db: OrchestrationDb,
  runId: string,
  context: NativeAntigravityReadinessContext,
  now = Date.now(),
  monotonicNow = performance.now()
): NativeAntigravityReadinessContext {
  const route = requireRunCapacity(db, runId).RUN_ROUTING_POSTURE.routes.find(
    (entry) => entry.route_identity === 'antigravity'
  )
  const receipt = receiptsFor(db).get(runId)
  const reason =
    context.runId !== runId || context.generation !== db.getRunRaw(runId)?.consumer_generation
      ? 'identity_changed'
      : !receipt || route?.runtime_readiness_receipt_id !== receipt.receiptId
        ? 'unverified_receipt'
        : antigravityReceiptExpired(receipt, now, monotonicNow)
          ? 'expired'
          : receipt.contextBinding !== context.fingerprint
            ? 'identity_changed'
            : receipt.readiness !== 'READY'
              ? receipt.reason
              : undefined
  if (reason) {
    throw new OrchestrationError(
      'ROUTE_NOT_READY',
      'Antigravity requires a fresh runtime-owned readiness receipt for this launch.',
      {
        runId,
        route: 'antigravity',
        readiness: 'UNKNOWN',
        reason,
        effectsApplied: false,
        workerCreated: false,
        routeSelectedByRuntime: false
      }
    )
  }
  requireRouteDispatchable(db, runId, { agent: 'antigravity', model: ANTIGRAVITY_READINESS_MODEL })
  return context
}

export function antigravityReceiptExpired(
  receipt: AntigravityReceipt,
  now = Date.now(),
  monotonicNow = performance.now()
): boolean {
  return receipt.expiresAt <= now || receipt.monotonicExpiresAt <= monotonicNow
}

export function publicAntigravityReadinessReceipt(
  receipt: AntigravityReceipt & { cacheHit: boolean }
) {
  return {
    readiness: receipt.readiness,
    reason: receipt.reason,
    receiptId: receipt.receiptId,
    observedAt: receipt.observedAt,
    expiresAt: receipt.expiresAt,
    runtimeHost: receipt.runtimeHost,
    model: receipt.model,
    inferenceMayConsumeTokens: receipt.inferenceMayConsumeTokens,
    cacheHit: receipt.cacheHit,
    inferenceEvidence: receipt.inferenceEvidence
  }
}
