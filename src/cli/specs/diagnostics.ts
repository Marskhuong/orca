import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const DIAGNOSTICS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['doctor'],
    summary: 'Check CLI and selected runtime build compatibility',
    usage: 'orca doctor [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Reads build identity and asks the selected runtime for status with a 1000ms timeout. No commands are retried or retargeted.'
    ],
    examples: ['orca doctor', 'orca doctor --json']
  },
  {
    path: ['diagnostics', 'memory'],
    summary: 'Collect a memory snapshot for Orca and managed terminals',
    usage: 'orca diagnostics memory [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Runs the same host process sweep used by the Resource Usage popover, so call it when you need a point-in-time diagnostic rather than a cheap heartbeat.'
    ],
    examples: ['orca diagnostics memory --json']
  }
]
