import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
export const JEV_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['jev', 'balance', 'set'],
    summary: 'Calibrate current Jev USD balance; subsequent tracked spend is deducted',
    usage: 'orca jev balance set --amount <USD> [--json]',
    allowedFlags: ['help', 'json', 'amount'],
    notes: [
      'Manual calibration, not provider-authoritative. Establishes a new accounting baseline without historical double-counting.'
    ]
  },
  {
    path: ['jev', 'usage'],
    summary: 'Read locally observed Jev tool usage and estimated cost',
    usage: 'orca jev usage [--json]',
    allowedFlags: ['help', 'json']
  },
  {
    path: ['jev', 'decide'],
    summary: 'One bounded TypeSafe structured decision; no worker or routing effects',
    usage: 'orca jev decide [--input <json-file>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'input'],
    notes: [
      'Reads native System-One JSON from --input or stdin. Questions may be a native named object or an array mapped to q0, q1, ….',
      'Always returns JSON. Uses the execution host credential (TYPESAFE_API_KEY or macOS Keychain Orca MK JEV API / JEV_API_KEY). No remote forwarding.',
      'One POST /v1/systemone, 20-second timeout, no retry or fallback. Default pinned model jev-1.13.0; model may be specified in JSON.',
      'Records sanitized usage and pricing-derived estimated cost locally. Remaining credit balance is NOT_AUTOMATED.'
    ]
  }
]
