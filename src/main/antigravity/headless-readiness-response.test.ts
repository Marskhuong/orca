import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAntigravityReadinessResponse } from './headless-readiness-response'

// Captured by the Lead's single approved inference; only cwd and conversation id are scrubbed.
const captured = readFileSync(join(__dirname, '__fixtures__', 'headless-ready.ndjson'), 'utf8')

describe('Antigravity headless readiness response', () => {
  it('accepts the captured exact-model completed inference', () => {
    expect(parseAntigravityReadinessResponse(captured, '<workspace>')).toMatchObject({
      accepted: true,
      inferenceEvidence: {
        model: 'gemini-3.8-flash-high',
        status: 'SUCCESS',
        response: 'AGY_READY_OK',
        inputTokens: 16082,
        outputTokens: 50,
        totalTokens: 16132,
        toolSteps: 0
      }
    })
  })

  it('accepts the captured 1.2.17 exact-model no-tool response', () => {
    const current = readFileSync(
      join(__dirname, '__fixtures__', 'headless-ready-1-2-17.ndjson'),
      'utf8'
    )
    expect(parseAntigravityReadinessResponse(current, '<workspace>')).toMatchObject({
      accepted: true,
      inferenceEvidence: {
        model: 'gemini-3.8-flash-high',
        status: 'SUCCESS',
        response: 'AGY_READY_OK',
        inputTokens: 12594,
        outputTokens: 49,
        totalTokens: 12643,
        toolSteps: 0
      }
    })
    expect(
      parseAntigravityReadinessResponse(
        current.replace('gemini-3.8-flash-high', 'future-model'),
        '<workspace>'
      )
    ).toMatchObject({ accepted: false, reason: 'model_error' })
  })

  it.each([
    ['model fallback', captured.replace('gemini-3.8-flash-high', 'gemini-3.8-flash-medium')],
    ['missing model', captured.replace('"model":"gemini-3.8-flash-high",', '')],
    ['different cwd', captured.replace('<workspace>', '<other-workspace>')],
    [
      'mismatched conversation',
      captured.replace(
        '"conversation_id":"captured-conversation","status"',
        '"conversation_id":"other","status"'
      )
    ],
    ['failed result', captured.replace('"status":"SUCCESS"', '"status":"ERROR"')],
    ['zero usage', captured.replaceAll('"output_tokens":50', '"output_tokens":0')],
    [
      'different response',
      captured.replace('"response":"AGY_READY_OK\\n"', '"response":"AGY_READY_OK extra"')
    ],
    ['multiple turns', captured.replace('"num_turns":1', '"num_turns":2')],
    ['partial output', captured.split('\n').slice(0, 4).join('\n')],
    ['malformed JSON', `${captured}{`],
    ['tool step', captured.replace('"step_type":"agent_response"', '"step_type":"tool"')],
    [
      'tool metadata',
      captured.replace(
        '"step_type":"agent_response"',
        '"tool_info":{},"step_type":"agent_response"'
      )
    ],
    [
      'subagent step',
      captured.replace(
        '"step_type":"agent_response"',
        '"subagent_info":{},"step_type":"agent_response"'
      )
    ],
    ['duplicate init', `${captured.split('\n')[0]}\n${captured}`],
    ['duplicate result', `${captured}${captured.trim().split('\n').at(-1)}\n`],
    [
      'unknown top-level error',
      captured.replace('"event":"init"', '"error":"provider failed","event":"init"')
    ],
    [
      'unknown result error',
      captured.replace('"status":"SUCCESS"', '"error":"provider failed","status":"SUCCESS"')
    ],
    ['unknown step error', captured.replace('"step_index":0', '"error":{},"step_index":0')],
    [
      'missing user input',
      captured
        .split('\n')
        .filter((line) => !line.includes('user_input'))
        .join('\n')
    ],
    ['regressing index', captured.replaceAll('"step_index":1', '"step_index":0')],
    [
      'mismatched response delta',
      captured.replace('"text_delta":"AGY_READY_OK"', '"text_delta":"WRONG"')
    ],
    [
      'non ASCII response whitespace',
      captured.replace('"response":"AGY_READY_OK\\n"', '"response":"AGY_READY_OK\\u00a0"')
    ],
    ['missing init', captured.split('\n').slice(1).join('\n')]
  ])('rejects %s', (_name, response) => {
    const parsed = parseAntigravityReadinessResponse(response, '<workspace>')
    expect(parsed.accepted).toBe(false)
    expect(parsed).not.toHaveProperty('inferenceEvidence')
  })

  it('allows harmless response whitespace without accepting extra text', () => {
    const response = captured.replace(
      '"response":"AGY_READY_OK\\n"',
      '"response":"  AGY_READY_OK\\n\\t"'
    )
    expect(parseAntigravityReadinessResponse(response, '<workspace>').accepted).toBe(true)
  })
})
