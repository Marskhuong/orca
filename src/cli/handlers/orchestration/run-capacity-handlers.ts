import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getRequiredStringFlag } from '../../flags'
import { RunCapacityEvidence } from '../../../shared/orchestration-run-capacity'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_RUN_CAPACITY_HANDLERS: Record<string, CommandHandler> = {
  'orchestration run-capacity-record': async ({ flags, client, cwd, json }) => {
    const evidence = RunCapacityEvidence.parse(JSON.parse(getRequiredStringFlag(flags, 'evidence')))
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation(
      client,
      flags,
      'orchestration.runCapacityRecord',
      {
        id: getRequiredStringFlag(flags, 'id'),
        from,
        evidence
      }
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
