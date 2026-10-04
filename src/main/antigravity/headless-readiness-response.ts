import { z } from 'zod'

export const ANTIGRAVITY_READINESS_MODEL = 'gemini-3.8-flash-high'
export const ANTIGRAVITY_READINESS_RESPONSE = 'AGY_READY_OK'

const Usage = z
  .object({
    input_tokens: z.number().int().positive(),
    output_tokens: z.number().int().positive(),
    thinking_tokens: z.number().int().nonnegative().optional(),
    cache_read_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().positive()
  })
  .strict()
const Init = z
  .object({
    event: z.literal('init'),
    conversation_id: z.string().min(1),
    init: z
      .object({
        model: z.literal(ANTIGRAVITY_READINESS_MODEL),
        cwd: z.string().min(1),
        tools: z.array(z.string()),
        permission_mode: z.string()
      })
      .strict()
  })
  .strict()
const Result = z
  .object({
    event: z.literal('result'),
    result: z
      .object({
        conversation_id: z.string().min(1),
        status: z.literal('SUCCESS'),
        response: z.string(),
        num_turns: z.literal(1),
        duration_seconds: z.number().nonnegative().optional(),
        usage: Usage
      })
      .strict()
  })
  .strict()
const Step = z
  .object({
    event: z.literal('step_update'),
    step_update: z
      .object({
        conversation_id: z.string().min(1),
        step_index: z.number().int().nonnegative(),
        step_type: z.enum(['user_input', 'agent_response', 'checkpoint']),
        state: z.enum(['ACTIVE', 'DONE']),
        text_delta: z.string().optional(),
        duration_seconds: z.number().nonnegative().optional(),
        usage: Usage.optional()
      })
      .strict()
  })
  .strict()
const Event = z.discriminatedUnion('event', [Init, Result, Step])
const asciiTrim = (text: string): string => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')

export type AntigravityInferenceEvidence = {
  model: typeof ANTIGRAVITY_READINESS_MODEL
  status: 'SUCCESS'
  response: typeof ANTIGRAVITY_READINESS_RESPONSE
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolSteps: 0
  durationSeconds?: number
}

export type AntigravityReadinessResponse =
  | { accepted: true; inferenceEvidence: AntigravityInferenceEvidence }
  | { accepted: false; reason: string }

export function parseAntigravityReadinessResponse(
  stdout: string,
  cwd: string
): AntigravityReadinessResponse {
  const reject = (reason = 'malformed_response'): AntigravityReadinessResponse => ({
    accepted: false,
    reason
  })
  let conversationId: string | undefined
  let completed = false
  let inferenceEvidence: AntigravityInferenceEvidence | undefined
  let userCompleted = false
  let responseCompleted = false
  let lastIndex = -1
  let lastState: 'ACTIVE' | 'DONE' | undefined
  let lastType: string | undefined
  let response = ''
  for (const line of asciiTrim(stdout).split('\n')) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return reject()
    }
    const encoded = JSON.stringify(value)
    if (
      /"(?:tool_info|tool_name|subagent_info)"|"step_type"\s*:\s*"(?:tool|subagent)/.test(encoded)
    ) {
      return reject('tool_activity')
    }
    if (/"(?:error|errors)"/.test(encoded)) {
      return reject('provider_error')
    }
    const modelEvent = z
      .object({ event: z.literal('init'), init: z.object({ model: z.string() }) })
      .safeParse(value)
    if (modelEvent.success && modelEvent.data.init.model !== ANTIGRAVITY_READINESS_MODEL) {
      return reject('model_error')
    }
    const parsed = Event.safeParse(value)
    if (!parsed.success || completed) {
      return reject()
    }
    const event = parsed.data
    if (event.event === 'init') {
      if (conversationId || event.init.cwd !== cwd) {
        return reject('identity_changed')
      }
      conversationId = event.conversation_id
      continue
    }
    const id =
      event.event === 'result' ? event.result.conversation_id : event.step_update.conversation_id
    if (!conversationId || id !== conversationId) {
      return reject('identity_changed')
    }
    if (event.event === 'step_update') {
      const step = event.step_update
      if (
        step.step_index < lastIndex ||
        (step.step_index === lastIndex && (lastState === 'DONE' || step.step_type !== lastType))
      ) {
        return reject()
      }
      if (step.step_index > lastIndex && lastState === 'ACTIVE') {
        return reject()
      }
      if (step.step_type === 'user_input') {
        if (userCompleted || step.state !== 'DONE' || lastIndex !== -1 || step.text_delta) {
          return reject()
        }
        userCompleted = true
      } else if (!userCompleted || responseCompleted) {
        return reject()
      }
      if (step.step_type === 'agent_response') {
        response += step.text_delta ?? ''
        responseCompleted = step.state === 'DONE'
      } else if (step.text_delta) {
        return reject()
      }
      lastIndex = step.step_index
      lastState = step.state
      lastType = step.step_type
      continue
    }
    if (
      !responseCompleted ||
      asciiTrim(event.result.response) !== ANTIGRAVITY_READINESS_RESPONSE ||
      asciiTrim(response) !== asciiTrim(event.result.response) ||
      event.result.usage.total_tokens <
        event.result.usage.input_tokens + event.result.usage.output_tokens
    ) {
      return reject()
    }
    inferenceEvidence = {
      model: ANTIGRAVITY_READINESS_MODEL,
      status: 'SUCCESS',
      response: ANTIGRAVITY_READINESS_RESPONSE,
      inputTokens: event.result.usage.input_tokens,
      outputTokens: event.result.usage.output_tokens,
      totalTokens: event.result.usage.total_tokens,
      toolSteps: 0,
      durationSeconds: event.result.duration_seconds
    }
    completed = true
  }
  return completed && inferenceEvidence ? { accepted: true, inferenceEvidence } : reject()
}
