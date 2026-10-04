import { describe, expect, it } from 'vitest'
import type { RunCapacityEvidence } from './orchestration-run-capacity'
import { RunCapacityEvidence as RunCapacityEvidenceSchema } from './orchestration-run-capacity'
import {
  evaluateRouteDispatch,
  resolveDispatchRoute,
  retiredRouteField
} from './orchestration-route-dispatch'

type Route = RunCapacityEvidence['RUN_ROUTING_POSTURE']['routes'][number]

function posture(routes: Partial<Route>[]): RunCapacityEvidence {
  return RunCapacityEvidenceSchema.parse({
    RUN_CAPACITY_SNAPSHOT_ID: 'snap',
    RUN_ROUTING_POSTURE: {
      RUN_CAPACITY_SNAPSHOT_ID: 'snap',
      capacity_observation_status: 'FRESH',
      routes: routes.map((route) => ({
        availability: 'AVAILABLE',
        availability_source: 'CAPACITY_SNAPSHOT',
        reserve: 'NONE',
        capacity_observation: 'OBSERVED',
        snapshot_id: 'snap',
        ...route
      }))
    }
  })
}

describe('route dispatch eligibility', () => {
  it('resolves an explicit route, then a model provider, then the agent', () => {
    expect(resolveDispatchRoute({ route: 'deepseek', agent: 'opencode' })).toEqual({
      identity: 'deepseek',
      source: 'explicit'
    })
    expect(resolveDispatchRoute({ agent: 'claude', model: 'anthropic/opus' })).toEqual({
      identity: 'anthropic',
      source: 'model'
    })
    expect(resolveDispatchRoute({ agent: 'codex', model: 'gpt-6' })).toEqual({
      identity: 'codex',
      source: 'agent'
    })
    expect(resolveDispatchRoute({})).toBeNull()
  })

  it.each([
    [{ route: 'qwen' }, 'route'],
    [{ agent: 'qwen-code' }, 'agent'],
    [{ agent: 'opencode', model: 'bailian-payg/qwen3-coder-next' }, 'model'],
    [{ agent: 'claude', model: 'qwen3-max' }, 'model'],
    [{ route: 'dashscope' }, 'route']
  ] as const)('recognizes %j as a retired route', (request, field) => {
    expect(retiredRouteField(request)).toBe(field)
  })

  it.each([
    { route: 'deepseek' },
    { agent: 'codex' },
    { agent: 'opencode', model: 'deepseek/deepseek-flash' }
  ])('does not treat %j as retired', (request) => {
    expect(retiredRouteField(request)).toBeNull()
  })

  it('refuses a retired route even when the posture records it AVAILABLE and READY', () => {
    const evidence = posture([{ route_identity: 'qwen', readiness: 'READY' }])
    expect(evaluateRouteDispatch(evidence, { route: 'qwen' })).toMatchObject({
      code: 'ROUTE_RETIRED_BY_POLICY',
      route: 'qwen'
    })
    expect(evaluateRouteDispatch(evidence, { agent: 'qwen-code' })).toMatchObject({
      code: 'ROUTE_RETIRED_BY_POLICY'
    })
  })

  it('refuses AVAILABLE but NOT_READY with the recorded reason', () => {
    const evidence = posture([
      {
        route_identity: 'deepseek',
        readiness: 'NOT_READY',
        readiness_reason: 'opencode provider missing'
      },
      { route_identity: 'codex', readiness: 'READY' }
    ])
    expect(evaluateRouteDispatch(evidence, { route: 'deepseek', agent: 'opencode' })).toEqual({
      code: 'ROUTE_NOT_READY',
      route: 'deepseek',
      reason: 'readiness_not_ready',
      readiness: 'NOT_READY',
      readinessReason: 'opencode provider missing',
      availability: 'AVAILABLE'
    })
    expect(evaluateRouteDispatch(evidence, { agent: 'codex' })).toBeNull()
  })

  it('fails closed on unrecorded or UNKNOWN readiness for a posture route', () => {
    const evidence = posture([
      { route_identity: 'claude' },
      { route_identity: 'codex', readiness: 'UNKNOWN' }
    ])
    expect(evaluateRouteDispatch(evidence, { agent: 'claude' })).toMatchObject({
      code: 'ROUTE_NOT_READY',
      readiness: 'UNRECORDED'
    })
    expect(evaluateRouteDispatch(evidence, { agent: 'codex' })).toMatchObject({
      code: 'ROUTE_NOT_READY',
      readiness: 'UNKNOWN'
    })
  })

  it.each(['PRESERVED', 'UNAVAILABLE'] as const)(
    'refuses a %s route even when READY',
    (availability) => {
      const evidence = posture([
        {
          route_identity: 'claude',
          availability,
          availability_source:
            availability === 'PRESERVED' ? 'PO_PRESERVE_INSTRUCTION' : 'LEAD_EVIDENCE',
          readiness: 'READY'
        }
      ])
      expect(evaluateRouteDispatch(evidence, { route: 'claude' })).toMatchObject({
        code: 'ROUTE_CAPACITY_NOT_AUTHORIZED',
        availability
      })
    }
  )

  it('refuses an explicit route the posture does not authorize', () => {
    expect(evaluateRouteDispatch(posture([]), { route: 'deepseek' })).toMatchObject({
      code: 'ROUTE_CAPACITY_NOT_AUTHORIZED',
      reason: 'route_absent_from_run_posture'
    })
  })

  it('fails closed when the dispatch names no posture route, even without recorded readiness', () => {
    const evidence = posture([{ route_identity: 'requested-route', availability: 'UNKNOWN' }])
    expect(evaluateRouteDispatch(evidence, { agent: 'codex' })).toMatchObject({
      code: 'ROUTE_IDENTITY_REQUIRED',
      reason: 'route_absent_from_run_posture'
    })
    expect(evaluateRouteDispatch(evidence, {})).toMatchObject({
      code: 'ROUTE_IDENTITY_REQUIRED',
      reason: 'route_unresolved'
    })
  })

  it('requires a route once the posture records readiness', () => {
    const evidence = posture([{ route_identity: 'deepseek', readiness: 'READY' }])
    expect(evaluateRouteDispatch(evidence, { agent: 'opencode' })).toMatchObject({
      code: 'ROUTE_IDENTITY_REQUIRED',
      route: 'opencode'
    })
    expect(evaluateRouteDispatch(evidence, { route: 'deepseek', agent: 'opencode' })).toBeNull()
  })

  it('rejects an invalid readiness value at registration', () => {
    const invalid: Partial<Route> = JSON.parse('{"route_identity":"codex","readiness":"MAYBE"}')
    expect(() => posture([invalid])).toThrow()
  })
  it('includes absent Antigravity honestly without changing the other posture routes', () => {
    const evidence = posture([{ route_identity: 'claude', readiness: 'READY' }])
    expect(evidence.RUN_ROUTING_POSTURE.routes[0]).toMatchObject({
      route_identity: 'claude',
      availability: 'AVAILABLE',
      readiness: 'READY'
    })
    expect(evidence.RUN_ROUTING_POSTURE.routes[1]).toMatchObject({
      route_identity: 'antigravity',
      availability: 'UNKNOWN',
      availability_source: 'NONE',
      readiness: 'UNKNOWN',
      snapshot_id: 'snap'
    })
    expect(RunCapacityEvidenceSchema.parse(evidence)).toEqual(evidence)
    expect(evaluateRouteDispatch(evidence, { agent: 'antigravity' })).toMatchObject({
      code: 'ROUTE_NOT_READY',
      route: 'antigravity',
      readiness: 'UNKNOWN'
    })
  })
  it('allows explicitly represented READY Antigravity without claiming known capacity', () => {
    const evidence = posture([
      {
        route_identity: 'antigravity',
        availability: 'UNKNOWN',
        availability_source: 'NONE',
        readiness: 'READY',
        readiness_reason: 'Bounded readiness check completed'
      }
    ])
    expect(evidence.RUN_ROUTING_POSTURE.routes).toHaveLength(1)
    expect(evidence.RUN_ROUTING_POSTURE.routes[0]?.availability).toBe('UNKNOWN')
    expect(resolveDispatchRoute({ agent: 'antigravity' })).toEqual({
      identity: 'antigravity',
      source: 'agent'
    })
    expect(evaluateRouteDispatch(evidence, { agent: 'antigravity' })).toBeNull()
    expect(
      evaluateRouteDispatch(evidence, {
        route: 'antigravity',
        agent: 'antigravity',
        model: 'google/opaque-model'
      })
    ).toBeNull()
  })
  it.each([undefined, 'UNKNOWN', 'NOT_READY'] as const)(
    'refuses Antigravity readiness %s without replacing explicit evidence',
    (readiness) => {
      const evidence = posture([
        {
          route_identity: 'antigravity',
          availability: 'UNKNOWN',
          availability_source: 'NONE',
          readiness
        }
      ])
      expect(evidence.RUN_ROUTING_POSTURE.routes).toHaveLength(1)
      expect(evaluateRouteDispatch(evidence, { agent: 'antigravity' })).toMatchObject({
        code: 'ROUTE_NOT_READY',
        readiness: readiness ?? 'UNRECORDED'
      })
    }
  )
  it('does not authorize unavailable Antigravity even when READY', () => {
    expect(
      evaluateRouteDispatch(
        posture([
          { route_identity: 'antigravity', availability: 'UNAVAILABLE', readiness: 'READY' }
        ]),
        { agent: 'antigravity' }
      )
    ).toMatchObject({ code: 'ROUTE_CAPACITY_NOT_AUTHORIZED' })
  })
  it('keeps the posture bounded when the readiness participant cannot fit', () => {
    expect(() =>
      posture(Array.from({ length: 1000 }, (_, i) => ({ route_identity: `route-${i}` })))
    ).toThrow('leave room')
  })
})
