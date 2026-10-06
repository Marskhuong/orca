import { z } from 'zod'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { extractAntigravityUserRequest } from '../../../shared/agent-hook-listener/transcript-lines'

const Record = z.object({
  step_index: z.number().int().nonnegative(),
  source: z.string(),
  type: z.string(),
  status: z.string(),
  created_at: z.string(),
  content: z.string()
})

// Worker evidence only; this does not enable AGY native chat or interpret settlement.
export function decodeAntigravityWorkerTranscriptLine(
  line: string,
  _fallbackId: string
): NativeChatMessage | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = Record.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const row = parsed.data
  const role =
    row.source === 'USER_EXPLICIT' && row.type === 'USER_INPUT'
      ? 'user'
      : row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE' && row.status === 'DONE'
        ? 'assistant'
        : null
  if (!role) {
    return null
  }
  const text = role === 'user' ? extractAntigravityUserRequest(row.content) : row.content
  if (!text?.trim()) {
    return null
  }
  const timestamp = Date.parse(row.created_at)
  return {
    id: `agy-step-${row.step_index}`,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    source: 'transcript'
  }
}
