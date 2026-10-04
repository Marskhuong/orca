import { z } from 'zod'

const SnapshotId = z.string().trim().min(1)
// Why: capacity AVAILABLE is not operational readiness; the coordinator records the result of its
// one bounded readiness check per route, and governed dispatch requires READY for the route it uses.
export const RouteReadiness = z.enum(['READY', 'NOT_READY', 'UNKNOWN'])
export const RunCapacityEvidence = z
  .object({
    RUN_CAPACITY_SNAPSHOT_ID: SnapshotId,
    RUN_ROUTING_POSTURE: z
      .object({
        RUN_CAPACITY_SNAPSHOT_ID: SnapshotId,
        capacity_observation_status: z.enum(['FRESH', 'REFRESHED', 'STALE_ACCEPTED', 'UNKNOWN']),
        routes: z
          .array(
            z
              .object({
                route_identity: z.string().trim().min(1),
                availability: z.enum([
                  'AVAILABLE',
                  'CONSTRAINED',
                  'UNAVAILABLE',
                  'UNKNOWN',
                  'PRESERVED'
                ]),
                availability_source: z.enum([
                  'LEAD_EVIDENCE',
                  'CAPACITY_SNAPSHOT',
                  'NONE',
                  'PO_PRESERVE_INSTRUCTION'
                ]),
                reserve: z.enum(['NONE', 'HIGH_VALUE_ONLY']),
                capacity_observation: z.string().min(1),
                snapshot_id: SnapshotId,
                readiness: RouteReadiness.optional(),
                readiness_reason: z.string().trim().min(1).max(512).optional()
              })
              .passthrough()
          )
          .max(1000)
      })
      .passthrough()
  })
  .superRefine((evidence, ctx) => {
    const posture = evidence.RUN_ROUTING_POSTURE
    if (
      posture.RUN_CAPACITY_SNAPSHOT_ID !== evidence.RUN_CAPACITY_SNAPSHOT_ID ||
      (posture.capacity_observation_status === 'UNKNOWN') !==
        (evidence.RUN_CAPACITY_SNAPSHOT_ID === 'UNKNOWN') ||
      posture.routes.some(
        (route) =>
          route.snapshot_id !== evidence.RUN_CAPACITY_SNAPSHOT_ID ||
          (route.availability === 'PRESERVED' &&
            route.availability_source !== 'PO_PRESERVE_INSTRUCTION')
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent Run capacity evidence' })
    }
  })

export type RunCapacityEvidence = z.infer<typeof RunCapacityEvidence>
export const RUN_CAPACITY_RUNTIME_CAPABILITY = 'orchestration.run-capacity.v1'
export const RunCapacityRecordParams = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  evidence: RunCapacityEvidence
})
export const RunCapacityShowParams = z.object({ id: z.string().min(1) })
