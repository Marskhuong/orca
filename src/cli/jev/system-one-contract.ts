import { z } from 'zod'

const json = z.json()
const description = z.record(z.string(), json)
const content = z.union([z.string(), description, z.array(json)])
const nullableContent = content.nullable()
const instructions = nullableContent.optional()
export const JevQuestion = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('noul'),
      instructions,
      criteria: z
        .object({ true: nullableContent.optional(), false: nullableContent.optional() })
        .strict()
        .nullable()
        .optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('choice'),
      instructions,
      criteria: z
        .record(z.string(), nullableContent)
        .refine((value) => Object.keys(value).length > 0)
    })
    .strict(),
  z
    .object({ type: z.literal('score'), instructions, criteria: z.array(content).min(1).max(256) })
    .strict()
])
export const JevRequest = z
  .object({
    state: z.union([z.string(), description, z.array(json)]),
    questions: z.union([
      z.array(JevQuestion).min(1).max(256),
      z
        .record(z.string().min(1), JevQuestion)
        .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 256)
    ]),
    model: z
      .string()
      .regex(/^jev-[A-Za-z0-9.-]+$/)
      .default('jev-1.13.0')
  })
  .strict()
const probability = z.number().finite().min(0).max(1)
const probabilities = z.record(z.string(), probability)
const Answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }).strict(),
  z
    .object({
      type: z.literal('choice'),
      choice: z.string(),
      confidence: probability,
      probabilities
    })
    .strict(),
  z
    .object({
      type: z.literal('score'),
      score: z.number().finite(),
      confidence: probability,
      probabilities,
      legend: z.record(z.string(), content)
    })
    .strict()
])
export const JevResponse = z
  .object({
    model: z.string().regex(/^jev-[A-Za-z0-9.-]+$/),
    answers: z.record(z.string(), Answer),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().safe(),
        output_tokens: z.number().int().nonnegative().safe()
      })
      .strict()
  })
  .strict()
export type JevNativeRequest = {
  state: z.infer<typeof JevRequest>['state']
  model: string
  questions: Record<string, z.infer<typeof JevQuestion>>
}

export function parseJevRequest(input: unknown): JevNativeRequest {
  const value = JevRequest.parse(input)
  return {
    ...value,
    questions: Array.isArray(value.questions)
      ? Object.fromEntries(value.questions.map((question, index) => [`q${index}`, question]))
      : value.questions
  }
}

export function canonicalJevJson(value: unknown, depth = 0): string {
  if (depth > 64) {
    throw new Error('invalid_request')
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJevJson(item, depth + 1)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJevJson(item, depth + 1)}`)
      .join(',')}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) {
    throw new Error('invalid_request')
  }
  return result
}

export function parseJevResponse(
  input: unknown,
  request: JevNativeRequest
): z.infer<typeof JevResponse> {
  const response = JevResponse.parse(input)
  if (!['jev-latest', 'jev-preview'].includes(request.model) && response.model !== request.model) {
    throw new Error('model_mismatch')
  }
  if (
    canonicalJevJson(Object.keys(response.answers).sort()) !==
    canonicalJevJson(Object.keys(request.questions).sort())
  ) {
    throw new Error('answer_mismatch')
  }
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = response.answers[name]
    if (!answer || answer.type !== question.type) {
      throw new Error('answer_mismatch')
    }
    if (question.type === 'choice' && answer.type === 'choice') {
      if (
        !Object.hasOwn(question.criteria, answer.choice) ||
        canonicalJevJson(Object.keys(answer.probabilities).sort()) !==
          canonicalJevJson(Object.keys(question.criteria).sort())
      ) {
        throw new Error('answer_mismatch')
      }
    }
    if (question.type === 'score' && answer.type === 'score') {
      const legend = Object.fromEntries(
        question.criteria.map((item, index) => [String(index), item])
      )
      if (
        answer.score < 0 ||
        answer.score > question.criteria.length - 1 ||
        canonicalJevJson(answer.legend) !== canonicalJevJson(legend) ||
        canonicalJevJson(Object.keys(answer.probabilities).sort()) !==
          canonicalJevJson(Object.keys(legend).sort())
      ) {
        throw new Error('answer_mismatch')
      }
    }
    if (
      'probabilities' in answer &&
      Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02
    ) {
      throw new Error('answer_mismatch')
    }
  }
  return response
}
