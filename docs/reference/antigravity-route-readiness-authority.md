# Antigravity route readiness authority gap

The runtime has no canonical, bounded, read-only probe that proves a new AGY
worker's operational readiness before allocation. Until that authority exists,
these sources cannot justify fresh `READY` for a governed route.

| Existing source | What it establishes | Why it cannot authorize a new worker |
| --- | --- | --- |
| `src/main/preflight/agent-detection.ts` and `src/relay/preflight-handler.ts` | Executable discovery on the selected host, with some version probes | Presence and version do not observe authentication or provider operation. |
| `src/main/antigravity/native-account-service.ts`, `prepareForLaunch` | A selected credential still matches the native credential storage | No provider request validates the credential; reconciliation can write the vault, so this is not a read-only readiness probe. |
| `src/main/rate-limits/antigravity-usage-fetcher.ts` | A current AGY quota reply and classified quota/auth failures | `/usage` is capacity metadata, not a model execution readiness contract; unsupported behavior can interpret it as a model prompt. |
| `src/main/runtime/agent-state-rules/antigravity.json` and `terminal wait --for tui-idle` | An existing PTY shows a quiet idle composer | This requires an allocated, running terminal and does not validate the provider behind the composer. |
| Hook server agent-status store | Host-owned state of an existing agent | A status row is not an authenticated pre-allocation observation for another Run, target, or launch configuration. |
| `src/main/runtime/orchestration/run-capacity-state.ts`, `requireRouteDispatchable` | The recorded route posture satisfies dispatch policy | The readiness value is supplied evidence; this gate does not discover or establish readiness. |

The quota command is version-fenced at AGY 1.1.11, bounded by a 30-second process
timeout, and latched off after a model-turn response. Those safeguards are useful
for quota reading but cannot guarantee that the first unsupported invocation sends
no provider prompt. Reusing it as a readiness probe would violate the required
pre-allocation boundary.

`src/main/rate-limits/antigravity-usage-error.ts` already distinguishes structured
authentication failures (`UNAUTHENTICATED`/401), entitlement failures
(`PERMISSION_DENIED`/403), capacity failures (`RESOURCE_EXHAUSTED`/429), and server
failures (5xx). This classifier can be reused when an authoritative observation
exists; an absent or timed-out observation supplies no positive readiness evidence.

The missing authority is an AGY-supported non-prompt operational/auth observation
with a documented response contract and captured evidence that it cannot fall
through to a model turn. The execution host must observe the actual launch context,
including the provider/model and credential authority, and bind the result to the
Run and resolved target. A runtime receipt must record observation time and reject
stale or mismatched evidence; missing, unsupported, and timed-out observations must
remain `UNKNOWN`. A local answer cannot substitute for SSH or WSL evidence.

No readiness producer, CLI command, gate change, or synthetic `READY` was added in
this investigation. Meter remains capacity-only. Routing, worker allocation,
watchdogs, and the existing capacity evidence contract were not changed.

Related contracts: [SSH execution boundary](./ssh-execution-boundary.md),
[agent status store](./agent-status-store.md),
[remote wire compatibility](./remote-wire-compatibility.md), and
[captured AGY terminal readiness](./antigravity-readiness-evidence.md).

## Investigation verification

The existing focused suites passed: four files, 117 tests. They verify the terminal
detector and quota probe contracts, not a new pre-allocation readiness authority.

```sh
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run \
  --config config/vitest.config.ts \
  src/main/runtime/antigravity-screen-readiness-transcripts.test.ts \
  src/main/runtime/antigravity-terminal-readiness.test.ts \
  src/main/rate-limits/antigravity-usage-fetcher.test.ts \
  src/main/rate-limits/antigravity-usage-error.test.ts
```

`pnpm` was unavailable on this worker's PATH, so the existing local Vitest entry
point was used directly, avoiding the package script's native-runtime preparation.
No build, dependency install, app restart, live provider probe, or smoke run occurred.
