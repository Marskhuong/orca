import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import {
  ANTIGRAVITY_COMPLETION_TTL_MS,
  redeemAntigravityCompletion
} from './antigravity-completion-capability'

const Hook = z.object({
  conversationId: z.string().uuid(),
  modelName: z.string().min(1),
  workspacePaths: z.array(z.string().min(1)).length(1),
  terminationReason: z.string().min(1).optional(),
  fullyIdle: z.boolean().optional(),
  error: z.string().optional()
})
const Envelope = z.object({
  paneKey: z.string(),
  launchToken: z.string().min(1),
  hook_event_name: z.enum(['PreInvocation', 'Stop']),
  payload: z.unknown()
})
type Registration = {
  dispatchId: string
  runtimeId: string
  launchTokenHash: string
  model: string
  workspacePath: string
  capability: string
  assertCurrent: () => void
  conversationId?: string
  expiresAt: number
  monotonicExpiry: number
}
const registrations = new Map<string, Registration>()

function expired(entry: Registration): boolean {
  return Date.now() >= entry.expiresAt || performance.now() >= entry.monotonicExpiry
}

export function registerAntigravityStopCompletion(
  paneKey: string,
  args: Omit<Registration, 'conversationId' | 'expiresAt' | 'monotonicExpiry'>
): void {
  for (const [pane, entry] of registrations) {
    if (expired(entry)) {
      registrations.delete(pane)
    }
  }
  if (registrations.has(paneKey) || registrations.size >= 512) {
    throw new Error('completion_hook_registration_conflict')
  }
  registrations.set(paneKey, {
    ...args,
    expiresAt: Date.now() + ANTIGRAVITY_COMPLETION_TTL_MS,
    monotonicExpiry: performance.now() + ANTIGRAVITY_COMPLETION_TTL_MS
  })
}

/** Only the authenticated, live local hook listener may call this adapter. */
export function observeAntigravityCompletionHook(body: unknown): void {
  const envelope = Envelope.safeParse(body)
  if (!envelope.success) {
    return
  }
  const { paneKey, launchToken, hook_event_name: event, payload } = envelope.data
  const entry = registrations.get(paneKey)
  if (!entry) {
    return
  }
  if (expired(entry)) {
    registrations.delete(paneKey)
    return
  }
  if (createHash('sha256').update(launchToken).digest('hex') !== entry.launchTokenHash) {
    throw new Error('completion_hook_launch_mismatch')
  }
  const hook = Hook.parse(typeof payload === 'string' ? JSON.parse(payload) : payload)
  if (hook.modelName !== entry.model || hook.workspacePaths[0] !== entry.workspacePath) {
    throw new Error('completion_hook_context_mismatch')
  }
  entry.assertCurrent()
  if (event === 'PreInvocation') {
    if (entry.conversationId && entry.conversationId !== hook.conversationId) {
      throw new Error('completion_hook_conversation_mismatch')
    }
    if (
      [...registrations.values()].some(
        (other) => other !== entry && other.conversationId === hook.conversationId
      )
    ) {
      throw new Error('completion_hook_conversation_conflict')
    }
    entry.conversationId = hook.conversationId
    return
  }
  if (!entry.conversationId || entry.conversationId !== hook.conversationId) {
    throw new Error('completion_hook_conversation_mismatch')
  }
  if (hook.fullyIdle !== true) {
    return
  }
  const outcome =
    hook.terminationReason === 'NO_TOOL_CALL' && !hook.error
      ? 'succeeded'
      : hook.error || ['error', 'max_steps_exceeded'].includes(hook.terminationReason ?? '')
        ? 'failed'
        : null
  if (!outcome) {
    return
  }
  registrations.delete(paneKey)
  redeemAntigravityCompletion(entry.capability, {
    dispatchId: entry.dispatchId,
    runtimeId: entry.runtimeId,
    outcome,
    summary: `AGY Stop: ${hook.terminationReason ?? 'error'}`.slice(0, 2048)
  })
}
