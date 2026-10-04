import type { RunCapacityEvidence } from './orchestration-run-capacity'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { retiredRouteField } from './orchestration-route-dispatch'

/** Every launchable agent id as a READY posture route, so lifecycle fixtures pass the route check. */
const FIXTURE_ROUTES = [
  'requested-route',
  ...Object.keys(TUI_AGENT_CONFIG).filter((agent) => retiredRouteField({ agent }) === null)
]

export function capacityEvidence(
  availability: 'AVAILABLE' | 'CONSTRAINED' | 'UNKNOWN' | 'UNAVAILABLE' = 'UNKNOWN'
): RunCapacityEvidence {
  const snapshot = availability === 'UNKNOWN' ? 'UNKNOWN' : 'snapshot-test'
  return {
    RUN_CAPACITY_SNAPSHOT_ID: snapshot,
    RUN_ROUTING_POSTURE: {
      RUN_CAPACITY_SNAPSHOT_ID: snapshot,
      capacity_observation_status: availability === 'UNKNOWN' ? 'UNKNOWN' : 'FRESH',
      routes: FIXTURE_ROUTES.map((route_identity) => ({
        route_identity,
        availability,
        availability_source: availability === 'UNKNOWN' ? 'NONE' : 'LEAD_EVIDENCE',
        reserve: 'NONE',
        capacity_observation: availability === 'UNKNOWN' ? 'UNKNOWN' : 'OBSERVED',
        snapshot_id: snapshot,
        readiness: route_identity === 'antigravity' ? 'UNKNOWN' : 'READY'
      }))
    }
  }
}
