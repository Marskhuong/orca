import { z } from 'zod'
import { RunCapacityEvidence } from '../../../shared/orchestration-run-capacity'
import {
  routeDispatchRefusal,
  runCapacityHandshakeRequiredRefusal
} from '../../../shared/orchestration-dispatch-refusal-contract'
import {
  evaluateRouteDispatch,
  type DispatchRouteRequest
} from '../../../shared/orchestration-route-dispatch'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'

export const RUN_CAPACITY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS run_capacity_handshakes (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    evidence TEXT NOT NULL,
    home_peer_fingerprint TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`

export function readRunCapacity(
  db: OrchestrationDb,
  runId: string
): RunCapacityEvidence | undefined {
  const row = z
    .object({ evidence: z.string() })
    .safeParse(
      db.db.prepare('SELECT evidence FROM run_capacity_handshakes WHERE run_id = ?').get(runId)
    )
  if (!row.success) {
    return undefined
  }
  try {
    const parsed = RunCapacityEvidence.safeParse(JSON.parse(row.data.evidence))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function requireRunCapacity(db: OrchestrationDb, runId: string): RunCapacityEvidence {
  const evidence = readRunCapacity(db, runId)
  if (evidence) {
    return evidence
  }
  const refusal = runCapacityHandshakeRequiredRefusal(runId)
  throw new OrchestrationError(refusal.code, refusal.message, refusal.data)
}

/** The host-resolved agent running in an existing terminal, when the host can name it. */
export async function terminalAgentIdentity(
  runtime: { showTerminal(handle: string): Promise<{ agentIdentity?: string }> },
  handle: string
): Promise<string | undefined> {
  try {
    return (await runtime.showTerminal(handle)).agentIdentity
  } catch {
    return undefined
  }
}

/** Policy eligibility and readiness for the route this dispatch names or implies; capacity first. */
export function requireRouteDispatchable(
  db: OrchestrationDb,
  runId: string,
  request: DispatchRouteRequest
): RunCapacityEvidence {
  const evidence = requireRunCapacity(db, runId)
  const refusal = evaluateRouteDispatch(evidence, request)
  if (refusal) {
    const receipt = routeDispatchRefusal(runId, refusal)
    throw new OrchestrationError(receipt.code, receipt.message, receipt.data)
  }
  return evidence
}

export function recordRunCapacity(
  db: OrchestrationDb,
  runId: string,
  input: unknown,
  homePeerFingerprint: string | null = null
): RunCapacityEvidence {
  const evidence = RunCapacityEvidence.parse(input)
  db.requireRun(runId)
  const run = db.getRunRaw(runId)!
  if ((run.home_database === 'remote') !== (homePeerFingerprint !== null)) {
    throw new OrchestrationError(
      'resource_server_mismatch',
      'Capacity evidence must come from the Run home.'
    )
  }
  if (
    homePeerFingerprint !== null &&
    db.db
      .prepare(
        'SELECT 1 FROM remote_dispatch_attachments WHERE home_run_id = ? AND home_peer_fingerprint != ? LIMIT 1'
      )
      .get(runId, homePeerFingerprint)
  ) {
    throw new OrchestrationError(
      'resource_server_mismatch',
      'Capacity evidence belongs to another Run home.'
    )
  }
  const existing = z
    .object({ home_peer_fingerprint: z.string().nullable() })
    .safeParse(
      db.db
        .prepare('SELECT home_peer_fingerprint FROM run_capacity_handshakes WHERE run_id = ?')
        .get(runId)
    )
  if (existing.success && existing.data.home_peer_fingerprint !== homePeerFingerprint) {
    throw new OrchestrationError(
      'resource_server_mismatch',
      'Capacity evidence belongs to another Run home.'
    )
  }
  db.db
    .prepare(`INSERT INTO run_capacity_handshakes (run_id, evidence, home_peer_fingerprint)
    VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET evidence = excluded.evidence,
    recorded_at = datetime('now')`)
    .run(runId, JSON.stringify(evidence), homePeerFingerprint)
  return evidence
}
