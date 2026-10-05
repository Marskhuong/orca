import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJevBalance, setJevBalance } from './jev-balance'
import { recordJevUsage } from './jev-usage-record'
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-jev-balance-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
async function spend(inputTokens: number) {
  const result = {
    status: 'succeeded' as const,
    requestId: randomUUID(),
    durationMs: 1,
    retryable: false as const,
    effectiveModel: 'jev-1.13.0',
    answers: {},
    usage: { input_tokens: inputTokens, output_tokens: 0 }
  }
  await recordJevUsage(result, directory)
}
describe('manual Jev calibration over existing usage journal', () => {
  it('has no fabricated balance before calibration', async () => {
    await spend(10_000_000)
    expect(await readJevBalance(directory)).toBeNull()
  })
  it('excludes historical spend and deducts only subsequent tracked records', async () => {
    await spend(10_000_000)
    expect(await setJevBalance('10.00', directory)).toMatchObject({
      status: 'calibrated',
      provenance: 'manual_calibrated'
    })
    expect(await readJevBalance(directory)).toMatchObject({
      usedUsd: '0.000000000',
      remainingUsd: '10.000000000'
    })
    await spend(10_000_000)
    expect(await readJevBalance(directory)).toMatchObject({
      usedUsd: '0.420000000',
      remainingUsd: '9.580000000'
    })
    await setJevBalance('14.51', directory)
    expect(await readJevBalance(directory)).toMatchObject({
      usedUsd: '0.000000000',
      remainingUsd: '14.510000000'
    })
    await spend(10_000_000)
    expect(await readJevBalance(directory)).toMatchObject({
      usedUsd: '0.420000000',
      remainingUsd: '14.090000000'
    })
  })
  it('persists across reads, without storing credentials or inference contents', async () => {
    await setJevBalance('0.01', directory)
    expect(await readJevBalance(directory)).toMatchObject({ remainingUsd: '0.010000000' })
    const raw = await readFile(join(directory, 'balance-baseline.state'), 'utf8')
    expect(raw).toContain('manual_calibrated')
    expect(raw).not.toMatch(/credential|answers|prompt/)
  })
  it.each(['-1', 'NaN', 'Infinity', '1.001', '$10', '', '1000000000'])(
    'rejects invalid amount %s',
    async (amount) => {
      await expect(setJevBalance(amount, directory)).rejects.toThrow('INVALID_BALANCE_AMOUNT')
      expect(await readJevBalance(directory)).toBeNull()
    }
  )
  it('fails closed on malformed baseline or unaccounted usage', async () => {
    await writeFile(join(directory, 'balance-baseline.state'), '{')
    expect(await readJevBalance(directory)).toBeNull()
    await writeFile(join(directory, 'broken.json'), '{')
    await expect(setJevBalance('10', directory)).rejects.toThrow('USAGE_NOT_FULLY_ACCOUNTED')
  })
  it('does not clamp an overspent calibrated balance to a fictional amount', async () => {
    await setJevBalance('0.01', directory)
    await spend(10_000_000)
    expect(await readJevBalance(directory)).toMatchObject({
      usedUsd: '0.420000000',
      remainingUsd: '-0.410000000'
    })
  })
})
