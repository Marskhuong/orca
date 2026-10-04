import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getRequiredStringFlag, getOptionalStringFlag } from '../../flags'
import {
  RunCapacityEvidence,
  ANTIGRAVITY_READINESS_RUNTIME_CAPABILITY
} from '../../../shared/orchestration-run-capacity'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_RUN_CAPACITY_HANDLERS: Record<string, CommandHandler> = {
  'orchestration run-capacity-record': async ({ flags, client, cwd, json }) => {
    const probeWorktree = getOptionalStringFlag(flags, 'agy-readiness-worktree')
    const evidence = probeWorktree
      ? undefined
      : RunCapacityEvidence.parse(JSON.parse(getRequiredStringFlag(flags, 'evidence')))
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation(
      client,
      flags,
      'orchestration.runCapacityRecord',
      {
        id: getRequiredStringFlag(flags, 'id'),
        from,
        ...(evidence ? { evidence } : {}),
        ...(probeWorktree
          ? {
              antigravityProbe: {
                worktree: probeWorktree,
                model: getRequiredStringFlag(flags, 'agy-readiness-model')
              }
            }
          : {})
      },
      probeWorktree
        ? { timeoutMs: 60_000, orchestrationCapability: ANTIGRAVITY_READINESS_RUNTIME_CAPABILITY }
        : undefined
    )
    printResult(result, json, (value) => JSON.stringify(value, null, 2))
  },
  'orchestration run-capacity-show': async ({ flags, client, json }) => {
    const result = await client.call('orchestration.runCapacityShow', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, (value) => JSON.stringify(value, null, 2))
  }
}
