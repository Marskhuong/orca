# Coordinator loop

Load this reference for expanded DAG waves, per-invocation launch preferences,
same-terminal reuse, or review ownership. The compact guide remains the source
of truth for the loop order and completion boundary.

## Run capacity handshake

Before the first substantive dispatch, read Orca Meter capacity evidence and complete
the Run capacity handshake. Register its `RUN_CAPACITY_SNAPSHOT_ID` and
`RUN_ROUTING_POSTURE` with `run-capacity-record`; `run-capacity-show --id <run id>`
reads the runtime's durable record. A bridge-local handshake alone is insufficient.
If capacity observation is unknown, a completed handshake with snapshot `UNKNOWN`
and a consistent posture satisfies the gate. Do not infer `UNAVAILABLE` or
`PRESERVED`. The runtime validates registration and leaves model and route selection
to the coordinator. Existing workers continue; the next substantive dispatch needs
the record. `RUN_CAPACITY_HANDSHAKE_REQUIRED` refuses before worker resources exist.

## Route readiness

`AVAILABLE` capacity is not readiness. Record each route's one bounded readiness
check in its posture entry as `readiness` (`READY`, `NOT_READY`, `UNKNOWN`) with an
optional `readiness_reason`, then name the chosen route on dispatch:

```text
ORCA orchestration worker-start --spec "<review>" --worktree current --agent opencode --route deepseek --json
```

Without `--route`, the route is the model's provider (`provider/model`) or the agent
id. A posture route that is `PRESERVED`, `UNAVAILABLE`, or not recorded `READY` is
refused with `ROUTE_CAPACITY_NOT_AUTHORIZED` or `ROUTE_NOT_READY`; once any route
records readiness, an unattributed dispatch gets `ROUTE_IDENTITY_REQUIRED`. Retired
routes (Qwen, Qwen Code, Bailian/DashScope models) get `ROUTE_RETIRED_BY_POLICY`
whatever the posture says. Every refusal has `effectsApplied: false` and
`workerCreated: false`. The runtime never picks a replacement: choose the next
capable and eligible route yourself and record `ROUTING_FALLBACK_REASON`.

Inside a Run, start every worker, reviewer, or additional agent with
`worker-start`. `worktree create --agent`, `terminal create` with an agent launch,
and `agent.launch` from a Run coordinator or active worker are refused with
`GOVERNED_DISPATCH_REQUIRED`. Keep a refusal visible; never replace it with a
direct provider CLI or a direct agent launch.

## Ready waves

Create independent Tasks before the first wait. Encode only real dependencies,
then use the ready view as external memory:

```text
ORCA orchestration task-create --spec "<dependent work>" --deps <json_array> --json
ORCA orchestration task-list --ready --brief --json
```

`--brief` collapses whitespace and caps echoed specs at 160 characters;
`spec_truncated` identifies shortened rows. Omit it when full specs are needed or
when an older CLI rejects the flag. A nested worker must respect
`nested_worker_depth_exceeded`; creating another Run does not reset depth.

## Launch preferences

For a fresh Claude, Codex, Cursor, Antigravity, or Muse terminal, `--model`
accepts an opaque provider model ID. Pass it only when the user named a model;
otherwise omit it so the worker inherits the user's configured agent default.
Add `--effort` only when that model supports it:

```text
ORCA orchestration worker-start --task <task_id> --worktree current --agent claude --model opus --effort high --json
ORCA orchestration worker-start --task <task_id> --worktree current --agent muse --model muse-spark-1.3 --json
```

Other agents, including `opencode`, reject `--model`; they run the model set in
their own config, so a coordinator wanting a same-model opencode worker relies
on that config.

`--effort` requires `--model`; neither option combines with `--terminal`. A
connected worker server must advertise launch-preference support before Orca
forwards either field. Compare `launch.requested` with `launch.effective`; never
claim a model or effort from requested arguments alone.

## Reuse after settlement

Choose the terminal's next owner before acknowledging the Delivery. When the
same exact agent has immediate follow-up work, recover the proven handle and
transfer cleanup ownership to the new Dispatch:

```text
ORCA orchestration worker-show --dispatch <dispatch_id> --json
ORCA orchestration worker-start --task <next_task_id> --terminal <agent_terminal_handle> --json
```

Otherwise explicitly retain or release the settled worker. Do not leave it live
only to inspect output; archived output remains available through `worker-read`.

## Review ownership

A review-only `worker_done` authorizes synthesis of findings, not coordinator
file edits. Dispatch or hand off fixes unless the user explicitly assigned them
to the coordinator. If the user's plan names a next owner, post-review fixes and
PR preparation remain with that owner; the coordinator routes and synthesizes.
