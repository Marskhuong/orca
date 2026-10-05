# Antigravity route readiness authority

The first two investigations below are historical. The bounded inference
implementation described in the final section supersedes their decision to stop;
`agy models`, quota replies, and idle terminal screens remain insufficient alone.

## Initial authority gap

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

## `agy models` investigation (2026-10-05)

Google's [Antigravity CLI codelab](https://codelabs.developers.google.com/antigravity-cli-hands-on#4)
documents `agy models` as an available-model listing. It does not promise fresh
authentication, a network response, or validation of the model a later launch
will use. This is a real metadata subcommand, unlike an unrecognized slash
command in print mode, but its output is not an authoritative readiness receipt.

The coordinator ran it once on the local host: exit 0, 3,821 ms, eighteen model
IDs, and `Fetching available models...` on stderr. The corresponding CLI log
shows silent keyring authentication at 02:41:51.678488 +0700 and a
`daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` request at
02:41:53.992524 +0700. That establishes a live request for this invocation;
neither the request log nor the model list records a response's provenance or
validates a later worker's selected model. No second provider invocation was
made by the worker investigating this candidate.

Read-only inspection of the installed macOS arm64 executable establishes why
the same output cannot be treated as a universal live observation. Its SHA-256
is `7dca095cfc1df2c057a385ed88a76c7ba98dc103258a80be87a8f42e484cb3aa`.
Function names come from its Go function table; addresses below are unslid
virtual addresses, inspected with LLDB without launching the executable.

| Installed function | Evidence |
| --- | --- |
| `entrypoints.modelsRun.run`, `0x102737750` | Reads backend state and calls `classifyModels`; the model-list output carries no auth-method, freshness, or request identity. |
| `entrypoints.classifyModels`, `0x102737bd0` | Checks startup/auth state and `AuthStatus.EligibilityError`, then returns a nonempty model list; no live-response provenance check is present in this classifier. |
| `codeassistclient.(*CodeAssistClient).fetchAvailableModels`, `0x1017ce7d0` | The `gemini_api_key` branch calls `geminimodels.Catalog` at `0x1017ce850` and returns with no error; the `adc` branch calls `buildDefaultAvailableModels` at `0x1017ce8fc` and returns with no error, before the HTTP branch. The `gateway` branch calls `buildGatewayAvailableModels` at `0x1017cebd0`. |
| `codeassistclient.(*CodeAssistClient).FetchAvailableModels`, `0x1017d09d0` | Reads `Cache.Get`; this accessor itself does not force a new request. |
| `codeassistclient.(*CodeAssistClient).GetFetchAvailableModelsResponse`, `0x1017cec50` | Conditionally calls `Cache.ClearAndRefresh`, then `Cache.Get`; a model result by itself does not identify which path supplied it. |

The static branches are concrete counterexamples to equating a model catalog
with provider validation. The cache calls do not prove that the coordinator's
observed result was stale; its log shows a live request. They do mean that the
public listing contract supplies no general fresh-response guarantee. The
installed command's help exposes only `-h/--help`, with no structured provenance
or requested-model validation option.

Model selection is a separate unresolved boundary. Orca already sends explicit
Antigravity selections through `--model` in
`src/shared/agent-session-option-catalog-antigravity.ts`; an omitted selection
uses the CLI's own configuration. The installed changelog distinguishes print
mode's hard failure for an unresolved model from interactive mode's fallback
with a warning. A catalog listing therefore cannot prove the exact model a
subsequent interactive worker will use, including its configured default or
wrapper/environment overrides. Parsing a global log would also permit another
process's observation to become evidence for this probe. A dedicated log could
improve correlation, but a request-start message still does not supply a
supported successful-response and effective-model contract.

Implementation stopped at this evidence boundary. No probe API, capability,
receipt, readiness producer, retry, fallback, task allocation, or gate change
was added. A fresh consumer model-list request is promising diagnostic evidence,
but `models` as currently documented and observed is insufficient to issue
runtime-owned `READY` for the actual launch configuration. Local evidence says
nothing about SSH, WSL, or another paired runtime. Existing route semantics and
native-account launch guards remain unchanged.

The six existing focused suites passed (142 tests): AGY screen/terminal
readiness, usage fetch/error handling, route dispatch, and AGY worker lifecycle.
Node typecheck and the changed-code quality gate also passed, as did
`git diff --check`. `pnpm` was unavailable on this worker's PATH, so verification
used the checked-in Node entry points directly, without native-runtime
preparation. No new probe tests were added because no probe implementation was
justified; timeout, receipt expiry/identity, remote capability, and duplicate
probe evidence remain requirements for any future authoritative implementation.


## Exact-model bounded inference implementation (2026-10-05)

The user subsequently authorized one minimal inference and rejection of any
observed tool activity. The coordinator captured a successful `stream-json`
response from the pinned AGY 1.2.14 macOS arm64 binary: exact
`gemini-3.8-flash-high`, one user step, one completed agent response, one SUCCESS
result, `AGY_READY_OK`, and positive usage. It took 6,917 ms and reported 16,082
input tokens and 50 output tokens. A short prompt can therefore consume substantial
context tokens. This capture validates the parser fixture; it is not itself a
runtime readiness receipt for a later launch.

`src/main/antigravity/headless-readiness-probe.ts` issues one print invocation with
that exact model, a 30-second provider deadline, a 35-second process deadline,
64 KiB output cap, and existing process-tree termination. READY also requires
verified process-group quiescence. Partial output, stderr, abort, nonzero exit,
unknown event fields, provider errors, tools/subagents, different cwd/model,
reordered or incomplete steps, mismatched response deltas, and absent positive
usage remain UNKNOWN. There is no retry or fallback. The process runner's bounded
termination grace adds time after its deadline; a child escaping into a new
session is outside the POSIX group guarantee.

`native-readiness-launch-context.ts` binds the Run id and current consumer
generation, runtime incarnation, resolved existing workspace, physical cwd,
audited executable digest, canonical Orca CLI path, selected native consumer
account, stable refresh authority, and bounded configuration digest. Cached access
and id-token refresh may change while issuer, subject, auth method, refresh token,
unknown credential fields, selected account, and configuration stay fixed. Native
credential reads do not reconcile or write the vault.

The supported path is deliberately narrow: native macOS, the audited executable,
consumer keyring authority, no file-token or keyring-fallback markers, no command,
argument, agent environment, or proxy overrides, and no alternate provider env.
Only the seven audited settings roots are accepted; unknown settings and nested
model/provider/endpoint-shaped JSON keys are rejected. The digest includes CLI
settings, jetski state, onboarding/default-project metadata, the home configuration
tree, and workspace `.agents` and `.gemini` trees. Symlinks, malformed JSON and
oversized trees refuse readiness. This is not a universal proof for future AGY
versions or untraced project/plugin configuration layers; an executable update or
unsupported configuration needs a fresh audit.

Both probe and worker use a fixed `/bin/bash --noprofile --norc -p -c` transport.
Bash builtins filter exported names and set fixed nonsecret provider values and
physical cwd. Canonical Orca hook, pane, workspace, CLI, and scrub-safe identity
environment names are preserved without expanding secrets into external argv.
Invalid/newline names, imported-function names, readonly unfilterable variables,
and multiline exported values fail closed before AGY; this limitation is tested.

`run-capacity-readiness.ts` owns a process-local receipt and single-flight cache
for 120 seconds per Run and exact context, checked against both monotonic and wall clocks. The existing Run posture receives only
readiness, reason, and receipt identity; capacity and Meter are unchanged. Public
registration cannot mint READY, restart invalidates private authority, and cached
checks restore the matching posture without another inference. Probe mode uses an
optional field on the existing capacity-record RPC and a new runtime capability,
so an older host cannot silently interpret it as ordinary evidence registration.

Governed worker start requires the exact model and a fresh matching receipt before
allocation, then revalidates context immediately before PTY spawn. Run generation
changes, terminal reuse/injection, new-worktree creation, SSH, WSL, federated
execution, and route/model-prefix laundering are refused. Direct local terminal
interaction and unrelated agents retain their existing behavior. The structured
headless response is distinct from a terminal-screen heuristic; the existing
captured idle detector is still used only after a supported worker starts.


Public receipts contain readiness/reason, receipt id, timestamps, runtime host,
exact model, cost flag, cache-hit status, and a small validated inference summary
(model, SUCCESS, fixed response, usage counts, zero tool steps and duration).
Private context, refresh-authority digests, generation and monotonic deadline do
not leave the runtime. An unverifiable existing terminal identity refuses governed
reuse/injection even when its declared route is unrelated, because the host cannot
exclude AGY; normal verified unrelated routes retain their existing policy. Hook
reinstallation or configuration changes invalidate a receipt, and workspace Gemini
settings containing model selectors are unsupported. The inference proves this
bounded print invocation; it does not promise the later interactive lifecycle will
complete successfully.

The exact global `.gemini/config/mcp_config.json` may be zero bytes: the approved
capture succeeded with that installed optional file. Its path and empty bytes stay
in the configuration digest; only this empty file is accepted. Nonempty malformed
MCP JSON, empty settings, and other malformed JSON still refuse observation.

## Governed Antigravity completion

Native governed Antigravity workers receive a completion-only command at launch.
It uses the existing loopback hook listener and does not discover or read runtime
metadata. A random in-memory capability authorizes one completion for the exact
runtime, dispatch, terminal and process incarnation. It expires after five minutes
on either wall or monotonic time; restart, reuse, identity changes and settled
workers fail closed. The capability is consumed before canonical `worker_done`
settlement, including ambiguous failures. There is no automatic retry or renewal.

The bundled CLI's `orchestration complete` command accepts only the launch-scoped
loopback endpoint, identities, capability, outcome and bounded summary. It cannot
query metadata or invoke generic runtime RPC. Existing sandbox permissions remain
unchanged; a provider sandbox denial must be reported rather than bypassed.
Non-Antigravity completion behavior is unchanged. Tasks exceeding the capability
TTL need coordinator intervention; this path does not grant lasting authority.
