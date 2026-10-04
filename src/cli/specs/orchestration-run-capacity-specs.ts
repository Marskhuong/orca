import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_RUN_CAPACITY_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'run-capacity-record'],
    summary: 'Register completed Run capacity handshake evidence',
    usage:
      'orca orchestration run-capacity-record --id <run_id> (--evidence <json> | --agy-readiness-worktree <workspace> --agy-readiness-model gemini-3.8-flash-high) [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'evidence',
      'from',
      'retry-request',
      'agy-readiness-worktree',
      'agy-readiness-model'
    ],
    identityFlagRoles: { from: 'caller' }
  },
  {
    path: ['orchestration', 'run-capacity-show'],
    summary: 'Read registered Run capacity handshake evidence',
    usage: 'orca orchestration run-capacity-show --id <run_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id']
  }
]
