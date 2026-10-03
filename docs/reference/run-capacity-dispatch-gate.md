# Run capacity dispatch gate

Substantive orchestration execution requires a valid capacity handshake registered
in the runtime database. A Run can still be created and inspected without one.
The refusal is `RUN_CAPACITY_HANDSHAKE_REQUIRED`, with the Run ID, message,
`effectsApplied: false`, `workerCreated: false`, and `nextSteps` in the native RPC
error envelope. The CLI's existing formatter preserves this code and recovery data.

## Baseline and upstream

- Installed source baseline: `84daac2de447bf1966ea573fae03ff796ce5779f`.
- Branch: `fix/runtime-capacity-dispatch-gate`.
- Baseline regression commit: `6e45f4055f`. The test failed because a starting worker
  and its inline Task were accepted without any capacity registration.
- Upstream examined and merged: `30e0ccaba65ed0ecb61deeacd1c333b3c5b71154`.
  Classification: **UPSTREAM_NOT_FIXED**. Neither the capacity contract nor an
  equivalent gate existed there. The implementation targets that upstream source.
- The installed application and its compiled bundle were not edited.

## Dispatch trace

The CLI `worker-launch-handler.ts` calls `callOrchestrationMutation` for
`orchestration.workerStart`. `RpcDispatcher` resolves caller authority and invokes
the registered handler through the durable mutation executor. `workers.ts` resolves
the coordinator's current Run and checks capacity before choosing the existing
worker mode and invoking the local or federated start service.

| Operation | Service and persistence boundary | Execution or allocation after the gate |
| --- | --- | --- |
| Worker, reviewer, secondary worker | `workers.ts` → `startLocalWorker` → `createStartingWorkerDispatch` | `placeWorkerAgent`: worktree, terminal, or structured session creation; preamble delivery |
| Existing terminal reuse | Same local worker path with `params.terminal` | Adopts terminal authority and delivers the Task preamble |
| Manual dispatch, including injection | `dispatch-methods.ts` → `createDispatchContext` | Capability issuance and `sendTerminalAgentPrompt` for injection |
| Nested worker execution | Same worker/manual paths, with `resolveDispatchCreator` and child depth | New Task/Dispatch and worker surface |
| Retry/redispatch | `createStartingWorkerDispatch`, with `retryOf` validation | A new Dispatch and new execution; previous worker is unchanged |
| Federation home | `startFederatedWorker` → `createStartingWorkerDispatch` | RPC `orchestration.federationAttachStart` with registered capacity evidence |
| Federation execution host | `federation.ts` → `createRemoteDispatchAttachment` | Remote worktree/terminal creation and preamble delivery |
| Legacy automatic coordinator | `dispatchReadyTasks` preflight → `dispatchTaskToWorker` → `createDispatchContext` | Terminal allocation and Task prompt delivery |

There is no separate reviewer or federation-execution RPC in this source: those
roles use the worker and attachment paths above. Context-only manual dispatch is
also gated because it issues a substantive Task attempt that can be delivered
manually. Dry-run dispatch returns before the persistence boundary.

The authoritative checks are at the three database creation methods above, sharing
`requireRunCapacity`. The starting-worker and attachment checks run inside their
write transactions. Worker preflight checks run before allocation; the coordinator
filters eligible Tasks before it creates a terminal. This additional check is
necessary because its historical loop allocates a terminal before creating a
Dispatch. Unregistered Runs do not starve other eligible Runs.

## Capacity ownership and integration

Finding: **B — a small runtime registration API is needed**. The current MCP bridge
stores capacity evidence in bridge-owned JSON files and verifies the Run using a
read-only CLI call. The baseline runtime has no Run metadata channel containing
that record. Reading the bridge file from the runtime would couple enforcement to
one client machine and would fail for independent runtimes and SSH use.

The bridge remains an evidence producer. The runtime stores the accepted handshake
in `run_capacity_handshakes`, keyed by Run ID, with its home peer and registration
time. Registration survives restart and is cleared with the Run on reset. New and
pre-existing Runs receive no synthesized handshake. Only future dispatch is gated;
worker reads, settlement, recovery, and cleanup do not retroactively cancel workers.

Supported APIs:

- `orchestration.runCapacityRecord`: coordinator-authorized durable mutation;
  params `{id, from, evidence}`.
- `orchestration.runCapacityShow`: read-only inspection; params `{id}`.
- CLI: `orchestration run-capacity-record --id <run_id> --evidence <json>` and
  `orchestration run-capacity-show --id <run_id>`.

`evidence` contains `RUN_CAPACITY_SNAPSHOT_ID` and `RUN_ROUTING_POSTURE`. The latter
contains the matching snapshot ID, observation status, and explicit route evidence.
The runtime validates consistency and records the supplied posture. It does not
query Meter, refresh providers, rank routes, select models, infer availability, or
manufacture preservation. `UNKNOWN`, `CONSTRAINED`, and even explicit unavailable
route evidence are valid handshake states; favorable capacity is not a precondition.
PRESERVED must already carry `PO_PRESERVE_INSTRUCTION` as its source.

The existing bridge's `orca_run_capacity_handshake` must call the registration API
and receive acknowledgment before claiming runtime registration. Until that adapter
is updated, a Lead can register the completed bridge/Meter evidence through the
CLI. A bridge-local `recorded: true` by itself will not permit runtime dispatch.
No related repository was modified, and no project-specific workaround is used.

## Federation and version skew

The runtime advertises `orchestration.run-capacity.v1`. A home refuses an older host
without that capability before accepting the worker Task/Dispatch. Capacity evidence
is an additive optional wire field, so old requests still parse; a receiver refuses
missing evidence before creating an attachment or remote Run. There is no silent
fallback to an ungated older host.

The receiver checks the authenticated home peer, including existing attachments
from before capacity enforcement. Another peer cannot claim a pre-gate remote Run
by registering its first handshake. A local Run collision is refused unless the
attachment matches its local home Dispatch, Run, and Task. This supports loopback
federation while requiring the local handshake and preserving local evidence.

SSH callers still reach the runtime control plane; no execution-host liveness or
process ownership decisions were added. Folder workspaces use the same Run gate.
Generic shell commands, ordinary terminal prompts, and unsupervised `agent.launch`
have no Task/Run dispatch identity; they remain outside this orchestration contract.
The gate does not classify free text or claim to prevent arbitrary same-user shell
execution. Babysitting policy is unchanged.

## Verification

`run-capacity-baseline.test.ts` preserves the failing installed-baseline regression.
The state, RPC, coordinator, and persistence suites cover the requested absence,
rollback, AVAILABLE/CONSTRAINED/UNKNOWN, retry, reviewer, injection/reuse, nested,
federation, read-only, dry-run, resource leak, existing worker, retroactive
registration, PRESERVED, explicit model/provider, and cross-project cases.

The disposable local smoke uses the real Run database and RPC dispatcher with
allocation spies: create an unregistered Run; receive the structured refusal;
verify no Task or resources; register UNKNOWN through the authorized API; start the
requested worker successfully. It launches no live provider or visible application
and does not mutate an active production Run.

Existing lifecycle fixtures explicitly use a capacity-ready test database. The gate
regressions use the real unseeded database; the RPC suite deletes fixture handshake
rows before each test. Independent review reran the five gate suites and checked
ownership, loopback, version skew, persistence, and resource boundaries.

Final test counts, type/lint/build results, and the implementation commit SHA are
reported with the completed change. Use the source patch on current upstream;
upgrading the installed application is necessary to obtain enforcement. Cherry-pick
the implementation after the baseline test when maintaining a release branch.

## Final validation

- Five focused gate suites: 43 tests passed, including the asynchronous terminal
  census recheck before coordinator allocation.
- Final relevant orchestration/runtime/CLI/shared package: 299 test files,
  2,702 tests passed, 10 skipped, zero failures.
- Node/runtime and CLI TypeScript checks passed.
- Changed-code quality gate passed with zero findings; generated contracts and
  bundled guide checks passed; `git diff --check` passed.
- Source CLI and headless `orcad` builds passed. The CLI build could not install its
  optional global `orca-dev` symlink due to directory permissions; compiled output
  and both capacity command help entries were verified.
- Independent review: PASS, including a separate rerun of the coordinator census
  race regression. No blocking governed dispatch bypass remained.
- Local smoke: PASS in the safe RPC/database harness described above. No live
  provider, desktop application, production Run, or installed bundle was used.

Deployment requires upgrading the runtime and connecting the bridge handshake to
its registration API. This source change does not claim to upgrade the installed
1.4.216 app or modify the separate bridge repository.

## Changed file manifest

Most existing test-file changes explicitly register capacity in lifecycle fixtures.
The dedicated gate tests retain unregistered Runs for refusal assertions.

- `.gitignore`
- `docs/reference/run-capacity-dispatch-gate.md`
- `skill-guides/orchestration.md`
- `skill-guides/orchestration/references/coordinator-loop.md`
- `src/cli/bundled-skill-guides.ts`
- `src/cli/handlers/orchestration-run-cli.test.ts`
- `src/cli/handlers/orchestration.ts`
- `src/cli/handlers/orchestration/run-capacity-handlers.ts`
- `src/cli/orchestration-dispatch-refusal-format.test.ts`
- `src/cli/specs/orchestration.ts`
- `src/cli/specs/orchestration-run-capacity-specs.ts`
- `src/cli/specs/orchestration-run-specs.ts`
- `src/main/runtime/orchestration-dispatch-mailbox-delivery.test.ts`
- `src/main/runtime/orchestration-mailbox-notification-test-harness.ts`
- `src/main/runtime/orchestration/capacity-ready-db.test-support.ts`
- `src/main/runtime/orchestration/coordinator-decision-gates.test.ts`
- `src/main/runtime/orchestration/coordinator-dispatch-unobserved-prompt.test.ts`
- `src/main/runtime/orchestration/coordinator-drift-probe-coalescing.test.ts`
- `src/main/runtime/orchestration/coordinator-escalation-triage.test.ts`
- `src/main/runtime/orchestration/coordinator-terminal-census-unavailable.test.ts`
- `src/main/runtime/orchestration/coordinator.test.ts`
- `src/main/runtime/orchestration/coordinator.ts`
- `src/main/runtime/orchestration/db-empty-dispatch-shortcircuit.benchmark.test.ts`
- `src/main/runtime/orchestration/db-heartbeat-straggler-guard.test.ts`
- `src/main/runtime/orchestration/db-stopping-worker-task-guard.test.ts`
- `src/main/runtime/orchestration/db-task-dispatch-invariant.test.ts`
- `src/main/runtime/orchestration/db-task-dispatch-lifecycle-guards.test.ts`
- `src/main/runtime/orchestration/db-task-dispatch-races.test.ts`
- `src/main/runtime/orchestration/db-task-promotion-projection.test.ts`
- `src/main/runtime/orchestration/db.test.ts`
- `src/main/runtime/orchestration/db/attempt-outcome-projection.test.ts`
- `src/main/runtime/orchestration/db/decision-gate-lifecycle.test.ts`
- `src/main/runtime/orchestration/db/dispatch-context/dispatch-context-store.ts`
- `src/main/runtime/orchestration/db/dispatch-depth.test.ts`
- `src/main/runtime/orchestration/db/dispatch-mailbox-consumer-fencing.test.ts`
- `src/main/runtime/orchestration/db/federation/federated-dispatch-observation-fence.test.ts`
- `src/main/runtime/orchestration/db/federation/remote-dispatch-attachment-create.ts`
- `src/main/runtime/orchestration/db/federation/remote-dispatch-attachment-release.test.ts`
- `src/main/runtime/orchestration/db/hot-path-statement-compilation.test.ts`
- `src/main/runtime/orchestration/db/messages/mailbox-consumer-lifecycle-fencing.test.ts`
- `src/main/runtime/orchestration/db/reset/orchestration-reset.ts`
- `src/main/runtime/orchestration/db/runs/run-coordinator-orca-session-binding.test.ts`
- `src/main/runtime/orchestration/db/schema/create-tables.ts`
- `src/main/runtime/orchestration/db/schema/derived-delivery-migration.test.ts`
- `src/main/runtime/orchestration/db/schema/federated-home-run-migration.test.ts`
- `src/main/runtime/orchestration/db/schema/structured-worker-orca-session-backfill.test.ts`
- `src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-abandon.test.ts`
- `src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-assignee-orca-session.test.ts`
- `src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-start.ts`
- `src/main/runtime/orchestration/dispatch-consumer-generation-migration.test.ts`
- `src/main/runtime/orchestration/dispatch-creator-identity-migration.test.ts`
- `src/main/runtime/orchestration/dispatch-failure-idempotency.test.ts`
- `src/main/runtime/orchestration/federation-acknowledgment-integrity.test.ts`
- `src/main/runtime/orchestration/federation-sync.test.ts`
- `src/main/runtime/orchestration/lifecycle-caller-edges.test.ts`
- `src/main/runtime/orchestration/lifecycle-reconciliation.test.ts`
- `src/main/runtime/orchestration/lightweight-run-worker-exit-escalation.test.ts`
- `src/main/runtime/orchestration/orchestration-adopted-run-binding.test.ts`
- `src/main/runtime/orchestration/orchestration-creator-authority-performance.test.ts`
- `src/main/runtime/orchestration/orchestration-db-retention-pagination.test.ts`
- `src/main/runtime/orchestration/orchestration-delivery-consumption.test.ts`
- `src/main/runtime/orchestration/orchestration-legacy-coordinator-authority-db.test.ts`
- `src/main/runtime/orchestration/orchestration-legacy-question-migration-db.test.ts`
- `src/main/runtime/orchestration/orchestration-legacy-storage-db.test.ts`
- `src/main/runtime/orchestration/orchestration-legacy-storage-test-fixture.ts`
- `src/main/runtime/orchestration/orchestration-mutation-question-db.test.ts`
- `src/main/runtime/orchestration/orchestration-orca-session-column-migration.test.ts`
- `src/main/runtime/orchestration/orchestration-reset-db.test.ts`
- `src/main/runtime/orchestration/orchestration-run-delivery-db.test.ts`
- `src/main/runtime/orchestration/orchestration-version-skew-migration.test.ts`
- `src/main/runtime/orchestration/orchestration-worker-dispatch-db.test.ts`
- `src/main/runtime/orchestration/r1-identity-migration.test.ts`
- `src/main/runtime/orchestration/run-capacity-baseline.test.ts`
- `src/main/runtime/orchestration/run-capacity-coordinator.test.ts`
- `src/main/runtime/orchestration/run-capacity-persistence.test.ts`
- `src/main/runtime/orchestration/run-capacity-state.test.ts`
- `src/main/runtime/orchestration/run-capacity-state.ts`
- `src/main/runtime/orchestration/run-coordinator-orca-session-address.test.ts`
- `src/main/runtime/orchestration/settled-question-threads-migration.test.ts`
- `src/main/runtime/orchestration/structured-session-mail-target.test.ts`
- `src/main/runtime/orchestration/worker-start-unobserved-prompt-settlement.test.ts`
- `src/main/runtime/rpc/errors.ts`
- `src/main/runtime/rpc/methods/orchestration-dispatch-error-codes.test.ts`
- `src/main/runtime/rpc/methods/orchestration-structured-worker-start-failure.test.ts`
- `src/main/runtime/rpc/methods/orchestration-worker-mode-opacity.test.ts`
- `src/main/runtime/rpc/methods/orchestration-worker-release-incarnation-fallback.test.ts`
- `src/main/runtime/rpc/methods/orchestration-worker-start-mode-selection.test.ts`
- `src/main/runtime/rpc/methods/orchestration.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federated-message-targeting.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federated-release-safety.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federated-worker-start-receipt.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federated-worker-start.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federation-agent-launch.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federation-control-mail.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federation-lifecycle-settlement.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federation-liveness-verdict.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federation-output.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federation-setup.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federation.test.ts`
- `src/main/runtime/rpc/methods/orchestration/federation/federation.ts`
- `src/main/runtime/rpc/methods/orchestration/messaging/check-worker-federated-attachment.test.ts`
- `src/main/runtime/rpc/methods/orchestration/rpc-test-harness.ts`
- `src/main/runtime/rpc/methods/orchestration/runs/migration-behavior.test.ts`
- `src/main/runtime/rpc/methods/orchestration/runs/run-capacity-methods.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/local-worker-start.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/manual-dispatch-observation.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/manual-dispatch-release.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/run-capacity-rpc.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/worker-abandon-caller.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/worker-interactive-wait.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/worker-list-run-scope-rpc.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/worker-release-recovery.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/worker-release.test-support.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/worker-start-prompt-contract.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/worker-stop-liveness-verdict.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/worker-terminal-custody-at-creation.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/workers-new-worktree.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/workers-recovery.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/workers.ts`
- `src/main/runtime/rpc/orchestration-11745-regression-verification.test.ts`
- `src/main/runtime/rpc/orchestration-commit-notify-characterization.test.ts`
- `src/main/runtime/rpc/orchestration-legacy-compatibility-dispatcher-test-fixture.ts`
- `src/main/runtime/rpc/orchestration-legacy-coordinator-race.test.ts`
- `src/main/runtime/rpc/orchestration-legacy-question-takeover.test.ts`
- `src/main/runtime/rpc/orchestration-legacy-takeover-delivery.test.ts`
- `src/main/runtime/rpc/orchestration-legacy-takeover-dispatcher.test.ts`
- `src/main/runtime/rpc/orchestration-mutation-ledger.test.ts`
- `src/main/runtime/rpc/orchestration-runtime-update-settlement.test.ts`
- `src/main/runtime/rpc/orchestration-session-caller-test-fixture.ts`
- `src/main/runtime/rpc/orchestration-session-caller.test.ts`
- `src/main/runtime/rpc/orchestration-session-caller.ts`
- `src/main/runtime/rpc/orchestration-task-dispatch-invariant.test.ts`
- `src/shared/orchestration-dispatch-refusal-contract.ts`
- `src/shared/orchestration-rpc-contract.ts`
- `src/shared/orchestration-run-capacity.test-support.ts`
- `src/shared/orchestration-run-capacity.ts`
- `src/shared/protocol-version.ts`
- `src/shared/rpc-contract/orchestration-federation-start-params.ts`
- `src/shared/rpc-contract/rpc-params-catalog.generated.ts`
