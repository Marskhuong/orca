import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { antigravityConfigurationDigest } from '../../antigravity/native-readiness-configuration'
import type { NativeAntigravityReadinessContext } from '../../antigravity/native-readiness-launch-context'
import { capacityEvidence } from '../../../shared/orchestration-run-capacity.test-support'
import { OrchestrationDb } from './db'
import {
  observeAntigravityRunReadiness,
  recordRunCapacity,
  requireAntigravityRunReadiness
} from './run-capacity-state'

describe('effective AGY configuration invalidates private readiness authority', () => {
  let home: string
  let cwd: string
  let db: OrchestrationDb
  let runId: string
  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'orca-agy-receipt-')))
    cwd = join(home, 'workspace')
    await mkdir(cwd)
    db = new OrchestrationDb(':memory:')
    runId = db.createRun({
      objective: 'context mutation',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
    recordRunCapacity(db, runId, capacityEvidence())
  })
  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })
  async function context(): Promise<NativeAntigravityReadinessContext> {
    return {
      runId,
      generation: db.getRunRaw(runId)?.consumer_generation ?? 0,
      fingerprint: await antigravityConfigurationDigest(home, cwd),
      program: '/audited/agy',
      cwd,
      env: {},
      command: 'agy',
      launchConfig: { agentCommand: 'agy', agentArgs: '', agentEnv: {} }
    }
  }
  it.each([
    'workspace/AGENTS.md',
    'workspace/GEMINI.md',
    'AGENTS.md',
    'GEMINI.md',
    'workspace/.agents/AGENTS.md',
    'workspace/.agents/GEMINI.md',
    'workspace/.agent/rules/legacy.md',
    'workspace/.agent/skills/legacy/SKILL.md',
    '.agents/rules/parent.md',
    '.agent/rules/parent.md',
    '.gemini/AGENTS.md',
    '.gemini/GEMINI.md',
    '.gemini/config/AGENTS.md',
    '.gemini/config/GEMINI.md',
    '.gemini/config/rules/global.md',
    '.gemini/config/skills/global/SKILL.md',
    '.gemini/antigravity-cli/rules/native.md',
    '.gemini/antigravity-cli/skills/native/SKILL.md',
    'referenced-include',
    'referenced-entry',
    'referenced-inheritance'
  ])('refuses a READY receipt after %s changes, without another inference', async (relative) => {
    const referenced = relative.startsWith('referenced-')
    const file = join(home, referenced ? 'external/rule.md' : relative)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'initial context')
    if (relative === 'referenced-include') {
      await writeFile(join(cwd, 'AGENTS.md'), '@[external](../external/rule.md)')
    } else if (referenced) {
      await mkdir(join(cwd, '.agents'))
      await writeFile(
        join(home, 'external/rules.json'),
        JSON.stringify({ entries: [{ path: 'rule.md' }] })
      )
      await writeFile(
        join(cwd, '.agents/rules.json'),
        JSON.stringify(
          relative === 'referenced-entry'
            ? { entries: [{ path: '../../external/rule.md' }] }
            : { inherits: [{ path: '../../external/rules.json' }] }
        )
      )
    }
    const observe = vi.fn(async () => ({
      readiness: 'READY' as const,
      reason: 'inference_completed'
    }))
    const before = await context()
    await observeAntigravityRunReadiness({ db, runId, resolveContext: context, observe })
    expect(requireAntigravityRunReadiness(db, runId, before)).toBe(before)
    await writeFile(file, 'changed context')
    const after = await context()
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(() => requireAntigravityRunReadiness(db, runId, after)).toThrowError(
      expect.objectContaining({ code: 'ROUTE_NOT_READY' })
    )
    expect(observe).toHaveBeenCalledOnce()
    expect(db.listTasks({ runId })).toEqual([])
  })
})
