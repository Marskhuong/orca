import { buildNativeAntigravityReadinessLaunchTransport } from './native-readiness-launch-command'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'
import { runProcess } from '../../shared/child-process/run-process'
import type { RouteReadiness } from '../../shared/orchestration-run-capacity'
import {
  ANTIGRAVITY_READINESS_MODEL,
  ANTIGRAVITY_READINESS_RESPONSE,
  type AntigravityInferenceEvidence,
  parseAntigravityReadinessResponse
} from './headless-readiness-response'

export const ANTIGRAVITY_READINESS_TIMEOUT_MS = 35_000
export const ANTIGRAVITY_READINESS_MAX_OUTPUT_BYTES = 64 * 1024

export type AntigravityReadinessObservation = {
  readiness: RouteReadiness
  reason: string
  inferenceEvidence?: AntigravityInferenceEvidence
}

function diagnosticReason(stderr: string): string {
  if (
    /authentication|unauthenticated|unauthorized|invalid.credentials|login required/i.test(stderr)
  ) {
    return 'auth_error'
  }
  if (/model.*(?:unsupported|unavailable|not.found|invalid)/i.test(stderr)) {
    return 'model_error'
  }
  if (/provider|gateway|rate.limit|quota|http.*(?:4\d\d|5\d\d)/i.test(stderr)) {
    return 'provider_error'
  }
  return 'process_error'
}

export async function probeAntigravityHeadlessReadiness(args: {
  program: string
  cwd: string
  env: Readonly<NodeJS.ProcessEnv>
  signal?: AbortSignal
  run?: typeof runProcess
}): Promise<AntigravityReadinessObservation> {
  if (args.signal?.aborted) {
    return { readiness: 'UNKNOWN', reason: 'aborted' }
  }
  try {
    const transport = buildNativeAntigravityReadinessLaunchTransport(
      [
        args.program,
        '-p',
        `Reply with exactly ${ANTIGRAVITY_READINESS_RESPONSE}. Do not use tools.`,
        '--model',
        ANTIGRAVITY_READINESS_MODEL,
        '--output-format',
        'stream-json',
        '--print-timeout',
        '30s',
        '--disable-slash-commands'
      ]
        .map((arg) => quoteStartupArg(arg, 'posix'))
        .join(' '),
      Object.fromEntries(
        Object.entries(args.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      args.cwd
    )
    const result = await (args.run ?? runProcess)({
      ...transport,
      cwd: args.cwd,
      env: { ...args.env },
      timeoutMs: ANTIGRAVITY_READINESS_TIMEOUT_MS,
      maxOutputBytes: ANTIGRAVITY_READINESS_MAX_OUTPUT_BYTES,
      killOnOutputLimit: true,
      detached: process.platform !== 'win32',
      terminationBarrier: true,
      quiesceGroupOnClose: true,
      signal: args.signal
    })
    if (
      args.signal?.aborted ||
      result.processGroupQuiescent !== true ||
      result.timedOut ||
      result.outputTruncated ||
      result.code !== 0 ||
      result.signal ||
      result.stderr.length > 0
    ) {
      return {
        readiness: 'UNKNOWN',
        reason: args.signal?.aborted
          ? 'aborted'
          : result.timedOut
            ? 'timeout'
            : result.outputTruncated
              ? 'output_limit'
              : result.processGroupQuiescent !== true
                ? 'cleanup_unverified'
                : diagnosticReason(result.stderr)
      }
    }
    const parsed = parseAntigravityReadinessResponse(result.stdout, args.cwd)
    return parsed.accepted
      ? {
          readiness: 'READY',
          reason: 'inference_completed',
          inferenceEvidence: parsed.inferenceEvidence
        }
      : { readiness: 'UNKNOWN', reason: parsed.reason }
  } catch {
    return { readiness: 'UNKNOWN', reason: 'process_error' }
  }
}
