import { z } from 'zod'

export const LEAD_YIELD_RUNTIME_CAPABILITY = 'orchestration.lead-yield.v1'
export const ParallelWorkReason = z.string().trim().min(1).max(240).optional()
