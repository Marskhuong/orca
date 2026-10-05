import { randomUUID } from 'node:crypto'
import { parseJevRequest } from '../jev/system-one-contract'
import { open } from 'node:fs/promises'
import type { CommandHandler } from '../dispatch'
import { decideWithJev, JEV_MAX_BYTES } from '../jev/system-one-decision'
import { readJevCredential } from '../jev/jev-credentials'
import { recordJevUsage } from '../jev/jev-usage-record'
import { setJevBalance, readJevBalance } from '../jev/jev-balance'
import { summarizeJevUsage } from '../jev/jev-usage-summary'

async function readInput(path: string | undefined): Promise<unknown> {
  let text = ''
  if (path) {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(JEV_MAX_BYTES + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > JEV_MAX_BYTES) {
        throw new Error('invalid_input')
      }
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
  } else {
    if (process.stdin.isTTY) {
      throw new Error('invalid_input')
    }
    const timer = setTimeout(() => process.stdin.destroy(new Error('input_timeout')), 3000)
    try {
      for await (const chunk of process.stdin) {
        text += String(chunk)
        if (Buffer.byteLength(text, 'utf8') > JEV_MAX_BYTES) {
          throw new Error('invalid_input')
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return JSON.parse(text)
}
const decide: CommandHandler = async ({ flags }) => {
  const started = performance.now()
  let result
  try {
    if (flags.has('environment') || flags.has('pairing-code')) {
      throw new Error('local_execution_required')
    }
    const inputFlag = flags.get('input')
    if (inputFlag !== undefined && typeof inputFlag !== 'string') {
      throw new Error('invalid_input')
    }
    const input = await readInput(inputFlag)
    parseJevRequest(input)
    result = await decideWithJev(input, await readJevCredential())
  } catch {
    result = {
      status: 'failed' as const,
      requestId: randomUUID(),
      durationMs: Math.round(performance.now() - started),
      retryable: false,
      error: { code: 'INPUT_OR_CREDENTIAL_SOURCE_INVALID' }
    }
  }
  const output =
    result.status === 'succeeded' ? { ...result, accounting: await recordJevUsage(result) } : result
  process.stdout.write(`${JSON.stringify(output)}\n`)
  if (result.status !== 'succeeded') {
    process.exitCode = 1
  }
}
const usage: CommandHandler = async () => {
  try {
    process.stdout.write(
      `${JSON.stringify({ ...(await summarizeJevUsage()), calibratedBalance: await readJevBalance() })}\n`
    )
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        status: 'outcome_unknown',
        retryable: false,
        error: { code: 'USAGE_READ_FAILED' }
      })}\n`
    )
    process.exitCode = 1
  }
}
export const JEV_HANDLERS: Record<string, CommandHandler> = {
  'jev decide': decide,
  'jev usage': usage,
  'jev balance set': async ({ flags }) => {
    try {
      const amount = flags.get('amount')
      if (typeof amount !== 'string') {
        throw new Error('INVALID_BALANCE_AMOUNT')
      }
      process.stdout.write(`${JSON.stringify(await setJevBalance(amount))}\n`)
    } catch {
      process.stdout.write(
        `${JSON.stringify({ status: 'failed', retryable: false, error: { code: 'BALANCE_CALIBRATION_FAILED' } })}\n`
      )
      process.exitCode = 1
    }
  }
}
