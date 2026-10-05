import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJevJson, parseJevRequest, parseJevResponse } from './system-one-contract'
import { decideWithJev, JEV_ENDPOINT } from './system-one-decision'
import { estimateJevCost, recordJevUsage } from './jev-usage-record'
import { summarizeJevUsage } from './jev-usage-summary'

const input = {
  state: { lamp: 'on' },
  questions: [{ type: 'noul', instructions: 'Is the lamp on?' }]
}
const response = {
  model: 'jev-1.13.0',
  answers: { q0: { type: 'noul', noul: 1 } },
  usage: { input_tokens: 32, output_tokens: 1 }
}
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('Jev shared decision tool', () => {
  it('maps question arrays to the native named schema deterministically', () => {
    expect(parseJevRequest(input)).toEqual({
      ...input,
      model: 'jev-1.13.0',
      questions: { q0: input.questions[0] }
    })
    expect(canonicalJevJson({ b: [2, 1], a: { z: null, c: 'x' } })).toBe(
      '{"a":{"c":"x","z":null},"b":[2,1]}'
    )
  })
  it('preserves native named questions and explicit aliases', () => {
    const request = parseJevRequest({
      ...input,
      model: 'jev-latest',
      questions: { lamp: input.questions[0] }
    })
    expect(
      parseJevResponse({ ...response, answers: { lamp: response.answers.q0 } }, request).model
    ).toBe('jev-1.13.0')
  })
  it.each([
    {},
    { ...input, state: true },
    { ...input, questions: [] },
    { ...input, questions: [{ type: 'chat' }] },
    { ...input, questions: [{ type: 'noul', instructions: 5 }] },
    { ...input, questions: [{ type: 'score', criteria: [null] }] },
    { ...input, prompt: 'not a chat tool' },
    { ...input, model: 'other-provider' }
  ])('rejects unsupported requests before network access: %j', async (invalid) => {
    const fetcher = vi.fn<typeof fetch>()
    expect(await decideWithJev(invalid, 'test-secret', { fetch: fetcher })).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_REQUEST' }
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('makes one direct official POST, preserving typed answers and raw usage without worker allocation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response))
    const result = await decideWithJev(input, 'test-secret', { fetch: fetcher })
    expect(result).toMatchObject({
      status: 'succeeded',
      effectiveModel: response.model,
      answers: response.answers,
      usage: response.usage,
      retryable: false
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(
      JEV_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: canonicalJevJson(parseJevRequest(input))
      })
    )
    expect(JSON.stringify(result)).not.toContain('test-secret')
    expect(result).not.toHaveProperty('dispatchId')
  })
  it('requires authentication without a request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    expect(await decideWithJev(input, null, { fetch: fetcher })).toMatchObject({
      error: { code: 'AUTH_REQUIRED' }
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([
    [401, 'AUTH_FAILED', 'failed'],
    [403, 'AUTH_FAILED', 'failed'],
    [422, 'PROVIDER_REJECTED', 'failed'],
    [429, 'PROVIDER_REJECTED', 'failed'],
    [503, 'PROVIDER_REJECTED', 'outcome_unknown']
  ])(
    'classifies HTTP %s without retry or leaking error bodies',
    async (status, code, expectedStatus) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('test-secret', { status: Number(status) }))
      const result = await decideWithJev(input, 'test-secret', { fetch: fetcher })
      expect(result).toMatchObject({
        status: expectedStatus,
        retryable: false,
        error: { code, httpStatus: status }
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(result)).not.toContain('test-secret')
    }
  )
  it('aborts the bounded request on timeout with no retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('private network details')),
            { once: true }
          )
        })
    )
    expect(
      await decideWithJev(input, 'test-secret', { fetch: fetcher, timeoutMs: 5 })
    ).toMatchObject({ status: 'outcome_unknown', retryable: false, error: { code: 'TIMEOUT' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('classifies a network ambiguity without retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private endpoint details'))
    expect(await decideWithJev(input, 'test-secret', { fetch: fetcher })).toMatchObject({
      status: 'outcome_unknown',
      error: { code: 'NETWORK_OR_PROVIDER_AMBIGUITY' }
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ...response, model: 'jev-1.12.0' },
    { ...response, answers: {} },
    { ...response, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...response, answers: { q0: { type: 'noul', noul: 2 } } },
    { ...response, usage: undefined }
  ])('fails closed on malformed or mismatched replies: %j', async (invalid) => {
    expect(
      await decideWithJev(input, 'test-secret', {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(invalid))
      })
    ).toMatchObject({
      status: 'outcome_unknown',
      error: { code: 'MALFORMED_OR_MISMATCHED_RESPONSE' }
    })
  })
  it('rejects malformed JSON', async () => {
    expect(
      await decideWithJev(input, 'test-secret', {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{'))
      })
    ).toMatchObject({ status: 'outcome_unknown' })
  })
  it('validates choice membership and score rubric identity', () => {
    const request = parseJevRequest({
      state: 'x',
      questions: { choice: { type: 'choice', criteria: { on: 'on', off: 'off' } } }
    })
    const valid = {
      ...response,
      answers: {
        choice: { type: 'choice', choice: 'on', confidence: 1, probabilities: { on: 1, off: 0 } }
      }
    }
    expect(parseJevResponse(valid, request).answers).toEqual(valid.answers)
    expect(() =>
      parseJevResponse(
        { ...valid, answers: { choice: { ...valid.answers.choice, choice: 'other' } } },
        request
      )
    ).toThrow()
    const score = parseJevRequest({
      state: 'x',
      questions: { rating: { type: 'score', criteria: ['low', 'high'] } }
    })
    const answer = {
      type: 'score',
      score: 1,
      confidence: 1,
      probabilities: { '0': 0, '1': 1 },
      legend: { '0': 'low', '1': 'high' }
    }
    expect(
      parseJevResponse({ ...response, answers: { rating: answer } }, score).answers.rating
    ).toEqual(answer)
    expect(() =>
      parseJevResponse(
        { ...response, answers: { rating: { ...answer, legend: { '0': 'wrong', '1': 'high' } } } },
        score
      )
    ).toThrow()
  })
})

describe('local Jev accounting', () => {
  it('uses exact documented input-only pricing and withholds unknown-model costs', () => {
    expect(estimateJevCost('jev-1.13.0', 1_000_000)).toBe('0.042000000')
    expect(estimateJevCost('jev-1.13.0', 32)).toBe('0.000001344')
    expect(estimateJevCost('jev-next', 32)).toBeNull()
  })
  it('records sanitized usage, summarizes it once, and isolates malformed records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-jev-'))
    directories.push(directory)
    const before = await summarizeJevUsage(directory)
    expect(before.calls).toBe(0)
    const result = await decideWithJev(input, 'test-secret', {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(response))
    })
    if (result.status !== 'succeeded') {
      throw new Error('test setup failed')
    }
    expect(await recordJevUsage(result, directory)).toMatchObject({
      status: 'recorded',
      estimatedCostUsd: '0.000001344',
      balance: 'NOT_AUTOMATED'
    })
    const raw = await readFile(join(directory, `${result.requestId}.json`), 'utf8')
    expect(raw).not.toContain('test-secret')
    expect(raw).not.toContain('lamp')
    expect(raw).not.toContain('answers')
    await writeFile(join(directory, 'duplicate.json'), raw)
    await writeFile(join(directory, 'bad.json'), '{')
    expect(await summarizeJevUsage(directory)).toMatchObject({
      status: 'partial',
      calls: 1,
      rejectedRecords: 1,
      inputTokens: '32',
      outputTokens: '1',
      estimatedCostUsd: '0.000001344',
      balance: 'NOT_AUTOMATED'
    })
    expect(await recordJevUsage(result, directory)).toMatchObject({ status: 'recording_failed' })
    expect(await readdir(directory)).toHaveLength(3)
  })
})
