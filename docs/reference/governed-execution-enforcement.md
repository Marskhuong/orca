# Governed execution and route readiness

This change extends the [Run capacity dispatch gate](run-capacity-dispatch-gate.md)
for canonical AGENTS policy 1.4.1 (`CANON-R027` to `CANON-R029`). The capacity gate is
unchanged and still runs first.

## Dispatch eligibility

`orchestration.workerStart` now requires, in order:

1. a recorded Run capacity handshake (`RUN_CAPACITY_HANDSHAKE_REQUIRED`, unchanged);
2. policy eligibility: a retired route is refused whatever the posture records
   (`ROUTE_RETIRED_BY_POLICY`);
3. capacity authorization for the route: a posture route that is `PRESERVED` or
   `UNAVAILABLE`, or an explicit `--route` absent from the posture, is refused
   (`ROUTE_CAPACITY_NOT_AUTHORIZED`);
4. operational readiness: the posture route must record `readiness: READY`;
   `NOT_READY`, `UNKNOWN`, or no recorded readiness is refused (`ROUTE_NOT_READY`).

All checks run in the handler before the Task, Dispatch, worktree, session, terminal,
federation call, or prompt exists. Every refusal carries `effectsApplied: false`,
`workerCreated: false`, and `routeSelectedByRuntime: false`. The runtime never ranks,
selects, or substitutes a route; the coordinator chooses the next route and records
`ROUTING_FALLBACK_REASON`.

The route is the `--route` the coordinator names, else the provider of a
`provider/model` model id, else the agent id. A dispatch that names no route present in
the posture keeps the capacity-only contract, unless the posture records readiness for
any route; then it is refused with `ROUTE_IDENTITY_REQUIRED`. This keeps existing Runs
and producers working while making readiness mandatory for every route a coordinator
has assessed. `opencode` workers run their configured model, so their route must be
named explicitly (for example `--route deepseek`).

Readiness is coordinator-supplied evidence from the one bounded readiness check
(`CANON-R007`), stored in the existing posture entry as optional `readiness`
(`READY | NOT_READY | UNKNOWN`) and `readiness_reason`. The runtime validates the enum
but performs no provider discovery or polling and creates no new capacity state.

The runtime advertises `orchestration.route-dispatch.v1`. The CLI refuses `--route`
against a runtime without it, because an older runtime would silently drop the field.

## Retired routes

Qwen is retired by Product Owner policy (`CANON-R029`). The runtime matches the
`route`, `agent`, and `model` of a dispatch by family token (`qwen*`, `bailian*`,
`dashscope*`), so `--route qwen`, `--agent qwen-code`, and
`--model bailian-payg/qwen3-coder-next` are all refused before any effect. This is
policy eligibility, not a capacity state. The upstream `qwen-code` TUI agent
definition remains for display, resume, and historical sessions; it is not a governed
dispatch route.

## Agent-launch fence

`agent.launch`, `agent.launchReplay`, `worktree.create` with a startup agent, command,
prompt, launch config, or draft, and `terminal.create` with `launchConfig`,
`launchAgent`, or `resumeProviderSession` refuse a caller that is the coordinator bound
to a Run or the assignee of an active Dispatch (`GOVERNED_DISPATCH_REQUIRED`). The
refusal happens before deduplication, worktree, or terminal creation.

The CLI now sends its caller evidence on `worktree.create` and `terminal.create` as it
already did on `orchestration.*` methods. The fence reads the declared terminal handle or
Orca session id and resolves the handle's live pane (Run binding is pane-keyed), falling
back to a declared pane key only for a handle this host cannot resolve. A forged identity
can only cause a refusal, never authorize anything.

## Boundaries

- Callers that send no orchestration evidence (desktop UI, mobile, human shells) are
  unaffected.
- A plain shell `terminal.create`, `terminal.create --command`, and `terminal.send` are
  transport. Their text is never parsed, so typing a provider CLI into a shell is
  outside this enforcement. A same-user process that strips its own Orca identity, or a
  provider CLI started outside Orca, is outside Orca's technical control.
- Manual `orchestration.dispatch` (with optional `--route`) and `worker-start --terminal`
  reuse take the target terminal's host-resolved agent identity as the route, so a
  retired agent terminal (for example a hand-started Qwen Code) is refused and readiness
  applies. The legacy automatic coordinator keeps the capacity gate only.
- The fence applies while a coordinator stays bound to a Run; Orca has no Run-close
  contract that unbinds it.

## Verification

- `src/shared/orchestration-route-dispatch.test.ts`: route resolution, retirement
  matching, and every refusal code.
- `src/main/runtime/rpc/methods/orchestration/worker/route-dispatch-rpc.test.ts`:
  AVAILABLE + NOT_READY refusal with zero effects, coordinator fallback to a READY
  route, retired Qwen dispatch, `ROUTE_IDENTITY_REQUIRED`, capacity-first ordering, and
  the agent-launch fence for all four surfaces, active workers, and unaffected callers.
- `src/cli/runtime-client.test.ts`: caller evidence on agent-launch surfaces only.
- Disposable-runtime E2E (source `orcad` + source CLI, private profile, fixture agents):
  missing handshake refusal, registration then dispatch, AVAILABLE + NOT_READY refusal
  with Lead-chosen fallback, retired Qwen refusals, and the coordinator/worker
  `worktree create --agent` fence with unaffected human and plain-create controls.
