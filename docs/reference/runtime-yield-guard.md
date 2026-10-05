# Runtime Yield Guard V1

Yield Guard records lifecycle evidence for CANON-R012 revision 3. It does not block
Lead execution, stop a Worker, suspend an agent, select a route, retry, or infer
failure. It adds no background timer, polling loop, provider call, or classifier.

## Lifecycle

A substantive dispatch is an accepted `worker-start` from the currently bound Run
coordinator, including a federated Worker, or a non-preview `dispatch --inject` to
another agent. System coordinator bookkeeping, context-only manual dispatch,
self dispatch, and nested Worker dispatch do not arm the guard.

The home runtime atomically records each accepted worker-start in
`lead_yield_expectations`. The fields are `dispatch_id`, `run_id`,
`consumer_generation`, `coordinator_identity`, `lead_yield_expected`,
`wait_count`, `poll_count`, `warned`, `created_at`, `wake_delivery_id`, and
`cleared_by`. A manual injected dispatch records its expectation after creation
and before prompt delivery.

`orca orchestration yield [--run <id>] [--from <caller>]` records the canonical
Runtime yield receipt for the current consumer. It sets `lead_yield_expected=0`
and `cleared_by=yield`; the Lead must then end its turn. This operation records
intent only and never suspends or controls execution. The existing external
Watchdog yield operation is separate; this change does not modify Watchdog.

A guarded evidence hook after a lifecycle transition of the dispatch to `completed`, `failed`, or
`circuit_broken` clears the expectation with `cleared_by=settled`. Only the
existing lifecycle can produce these transitions. `start_unknown`,
`stop_unknown`, `outcome_unknown`, transport loss, and silence are not settlement.

When a consuming check delivers `worker_done`, `question`, or `escalation`, the
expectations that existed before that delivery enter checkpoint processing:
`wake_delivery_id` records the delivered receipt, and detection stops for those
expectations. This does not claim that the Lead yielded and does not erase the
pending-yield evidence. A new dispatch independently arms a new expectation,
with no inherited wake exemption. Receiving or processing a wake is never a
violation. A status read while processing an outstanding delivery is exempt.

## High-confidence detection

While an expectation remains pending before yield or delivered wake:

- The **second** completed empty `check --wait` emits
  a warning. A wait that finds a delivery, reads history, or acknowledges a
  delivery is exempt. One isolated wait is tolerated.
- The **second** `worker-read` from the bound Lead, for an active Worker in the same Run,
  without a cursor emits a warning against that target dispatch only. Cursor pagination is exempt to avoid
  classifying legitimate bounded-output pagination as polling. `worker-show`
  status reads are exempt. Reads without verified terminal evidence or a resolved structured-session Lead are exempt.
- An additional substantive Worker dispatch emits a warning immediately for each
  prior pending expectation without an action-scoped parallel-work reason.

Counters saturate at two. There is no time window or elapsed-time inference;
the scope is one dispatch expectation. The first warning sets `warned=1`, so
later categories and repeated calls do not spam that dispatch. Separate
expectations have independent evidence. No arbitrary shell or editor action,
terminal output contents, or work-overlap semantics are classified.

`--parallel-work-reason <text>` is accepted on `worker-start`, `dispatch`,
`worker-read`, and `check`. The shared RPC field is `parallelWorkReason`: trimmed,
nonempty, at most 240 characters. It suppresses detection only for that call,
without resetting counters or clearing expectations. An audit-only
`PARALLEL_WORK_REASON` record names the dispatch and action it covered. It never
changes routing, capacity, readiness, or authorization. Reasons should contain
no secrets or task prompt text. Ordinary yield flow needs no reason.

Reply, delivery acknowledgment, permission handling, release, close, unwatch,
and lifecycle bookkeeping have no guard action hook. Required status reads
remain available. The guard favors false negatives: cursor reads, unknown
caller identity, and arbitrary commands are deliberately outside V1 detection.

## Durable evidence and compatibility

Warning and parallel-reason events reuse `messages`, with `type=status` and
`delivery_contract=audit_only`. A warning's subject is
`LEAD_DID_NOT_YIELD_AFTER_DISPATCH`. Its JSON payload contains `runId`,
`coordinatorIdentity`, `dispatchId`, `timestamp`, `actionCategory`,
`parallelWorkReasonExisted`, and `rule=CANON-R012 yield-by-default`. Scoped
parallel events additionally contain `PARALLEL_WORK_REASON`. No prompt or
Worker output is copied. Audit-only messages never enqueue a delivery or wake.

`run-show --json` exposes the latest 100 expectation rows in `yieldGuard`.
`check --run <id> --all --json`, `inbox`, and their existing RPC read surfaces
expose the audit records. Bridges using these surfaces can read them without a
new monitor. The runtime advertises `orchestration.lead-yield.v1`; the CLI
refuses explicit parallel evidence against a host that would silently drop it.
The new yield method fails normally against an older host.

Guard writes use savepoints and fixed, secret-free error logging. Evidence failures
never interrupt or roll back dispatch or settlement. Yield returns `yieldRecorded=false`
when its receipt could not be persisted.

The table is created empty for existing databases. No migration backfills old
Runs or historical dispatches. State and counters survive restart. Run consumer
generation fences attribution after rebind; new consumers do not inherit a
prior consumer's pending detection. The guard writes only its own state and
audit messages, leaving lifecycle, outcome, and capacity state intact. Watchdog
is unchanged and can surface the existing read evidence if desired.
