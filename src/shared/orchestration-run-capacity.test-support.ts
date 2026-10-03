import type { RunCapacityEvidence } from './orchestration-run-capacity'

export function capacityEvidence(
  availability: 'AVAILABLE' | 'CONSTRAINED' | 'UNKNOWN' | 'UNAVAILABLE' = 'UNKNOWN'
): RunCapacityEvidence {
  const snapshot = availability === 'UNKNOWN' ? 'UNKNOWN' : 'snapshot-test'
  return {
    RUN_CAPACITY_SNAPSHOT_ID: snapshot,
    RUN_ROUTING_POSTURE: {
      RUN_CAPACITY_SNAPSHOT_ID: snapshot,
      capacity_observation_status: availability === 'UNKNOWN' ? 'UNKNOWN' : 'FRESH',
      routes: [
        {
          route_identity: 'requested-route',
          availability,
          availability_source: availability === 'UNKNOWN' ? 'NONE' : 'LEAD_EVIDENCE',
          reserve: 'NONE',
          capacity_observation: availability === 'UNKNOWN' ? 'UNKNOWN' : 'OBSERVED',
          snapshot_id: snapshot
        }
      ]
    }
  }
}
