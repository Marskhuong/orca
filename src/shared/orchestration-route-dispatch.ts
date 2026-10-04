import type { z } from 'zod'
import type {
  RouteReadiness as RouteReadinessSchema,
  RunCapacityEvidence
} from './orchestration-run-capacity'

// Why: capacity says a route may be used; readiness says its execution path works. Governed
// dispatch needs policy eligibility, capacity authorization, and recorded READY readiness. The
// runtime only checks the route the coordinator named or the launch request implies; it never
// ranks, selects, or substitutes a route.
export const ROUTE_DISPATCH_RUNTIME_CAPABILITY = 'orchestration.route-dispatch.v1'

export type RouteReadiness = z.infer<typeof RouteReadinessSchema>

// Why: a Product Owner retirement is durable policy eligibility, not a capacity state, so it is
// matched by family token on the request itself and never depends on what the posture records.
const RETIRED_ROUTE_FAMILY_TOKENS = ['qwen', 'bailian', 'dashscope'] as const

export type DispatchRouteRequest = {
  route?: string | undefined
  agent?: string | undefined
  model?: string | undefined
}

export type ResolvedDispatchRoute = {
  identity: string
  source: 'explicit' | 'model' | 'agent'
}

/** The route a dispatch names or implies: an explicit route, else a model's provider, else its agent. */
export function resolveDispatchRoute(request: DispatchRouteRequest): ResolvedDispatchRoute | null {
  if (request.route) {
    return { identity: request.route, source: 'explicit' }
  }
  const slash = request.model?.indexOf('/') ?? -1
  if (request.model && slash > 0) {
    return { identity: request.model.slice(0, slash), source: 'model' }
  }
  return request.agent ? { identity: request.agent, source: 'agent' } : null
}

function hasRetiredToken(value: string | undefined): boolean {
  return (value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => RETIRED_ROUTE_FAMILY_TOKENS.some((retired) => token.startsWith(retired)))
}

/** Which request field names a retired route family, if any. */
export function retiredRouteField(
  request: DispatchRouteRequest
): 'route' | 'agent' | 'model' | null {
  for (const field of ['route', 'agent', 'model'] as const) {
    if (hasRetiredToken(request[field])) {
      return field
    }
  }
  return null
}

export type RouteDispatchRefusalCode =
  | 'ROUTE_RETIRED_BY_POLICY'
  | 'ROUTE_CAPACITY_NOT_AUTHORIZED'
  | 'ROUTE_NOT_READY'
  | 'ROUTE_IDENTITY_REQUIRED'

export type RouteDispatchRefusal = {
  code: RouteDispatchRefusalCode
  route: string | null
  reason: string
  readiness?: RouteReadiness | 'UNRECORDED'
  readinessReason?: string
  availability?: string
}

type PostureRoute = RunCapacityEvidence['RUN_ROUTING_POSTURE']['routes'][number]

/**
 * The refusal for this dispatch under the Run's recorded posture, or null when it may proceed.
 *
 * The dispatch must resolve to a posture route that is capacity-authorized and recorded READY.
 * An explicit route missing from the posture has no capacity authorization; any other dispatch
 * that names no posture route, or cannot be attributed at all, must name one.
 */
export function evaluateRouteDispatch(
  evidence: RunCapacityEvidence,
  request: DispatchRouteRequest
): RouteDispatchRefusal | null {
  const resolved = resolveDispatchRoute(request)
  const retired = retiredRouteField(request)
  if (retired) {
    return {
      code: 'ROUTE_RETIRED_BY_POLICY',
      route: request[retired] ?? null,
      reason: `${retired}_names_retired_route`
    }
  }
  const routes = evidence.RUN_ROUTING_POSTURE.routes
  const entry: PostureRoute | undefined = resolved
    ? routes.find((route) => route.route_identity === resolved.identity)
    : undefined
  if (!entry) {
    if (resolved?.source === 'explicit') {
      return {
        code: 'ROUTE_CAPACITY_NOT_AUTHORIZED',
        route: resolved.identity,
        reason: 'route_absent_from_run_posture'
      }
    }
    // Why: CANON-R028 fails closed on unrecorded readiness, so a dispatch must name a posture route.
    return {
      code: 'ROUTE_IDENTITY_REQUIRED',
      route: resolved?.identity ?? null,
      reason: resolved ? 'route_absent_from_run_posture' : 'route_unresolved'
    }
  }
  if (entry.availability === 'PRESERVED' || entry.availability === 'UNAVAILABLE') {
    return {
      code: 'ROUTE_CAPACITY_NOT_AUTHORIZED',
      route: entry.route_identity,
      reason: `route_${entry.availability.toLowerCase()}`,
      availability: entry.availability
    }
  }
  if (entry.readiness !== 'READY') {
    return {
      code: 'ROUTE_NOT_READY',
      route: entry.route_identity,
      reason: entry.readiness === undefined ? 'readiness_unrecorded' : 'readiness_not_ready',
      readiness: entry.readiness ?? 'UNRECORDED',
      ...(entry.readiness_reason ? { readinessReason: entry.readiness_reason } : {}),
      availability: entry.availability
    }
  }
  return null
}
