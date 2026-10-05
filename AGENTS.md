# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Most of it is linted: `pnpm run check:code-quality:changed` fails on new restyles of a `components/ui/` primitive, raw palette colors, and computed `className` strings; `pnpm lint` fails on any class Tailwind cannot generate. See the Enforcement section of the style guide before suppressing either. Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

## Electron UI Validation

Always run tests and agent-launched apps in the background with `ORCA_BACKGROUND_LAUNCH=1`.
Never steal monitor focus or reveal test windows: no `show()`, `showInactive()`, `bringToFront()`,
`app.focus()`, or OS activation. Use CDP screenshots of hidden renderers. Keep native-focus and
visible-window tests paused on the user's desktop; run them on an isolated display or CI.
Rebuild modified launch-policy code before running an app; stale build wrappers are not safe.

Use the `$electron` skill and Playwright CDP for rendered Orca UI checks. Do not use computer-use for Orca UI validation.

# Style

## Reuse Before Reimplementing

Before writing new logic at any scale — a function, component, IPC channel, state store, or whole subsystem/flow — check whether an existing implementation already does the job (or nearly does). Extend or generalize it instead of building a parallel version; only write from scratch when nothing fits. Keep the check proportionate: a quick search for trivial code, a real one before building anything substantial.

## Concise/Brief Non-obvious Comments ONLY

- DO NOT: be verbose, explain the obvious, walk through the code ("WHY not HOW")
- BE CONCISE. 1 LINE if possible

## Lint Rules: Do Not Disable Max Lines

NEVER add a `max-lines` disable (`eslint-disable max-lines`, `oxlint-disable max-lines`, or line-specific variants), and never add a per-file `max-lines` bump in `mobile/.oxlintrc.json`.

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Type Declarations: Prefer `.ts` Over `.d.ts`

## Type Assertions: Prefer Checked Types

Avoid type assertions except `as const`. Unavoidable casts need a line-specific `SAFETY:` explanation:

```ts
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Explain the verified invariant here.
```

# Verifying Changes

- **Typecheck**: `pnpm tc` (or `tc:node` / `tc:cli` / `tc:web`)
- **Test**: `pnpm test [path/to/file.test.ts]`
- **Lint**: `oxlint`, or `pnpm run check:code-quality:changed` for changed files (full `pnpm lint` is slow); format with `pnpm format`
- **Design system**: `pnpm run lint:design-system` for the full renderer report (not a gate); the changed-lines gate above is what CI enforces
- **Real Claude CLI**: when you change Claude structured-session code (`src/main/claude/claude-structured-*`), run `ORCA_REAL_CLAUDE_CLI_TEST=1 pnpm test src/main/claude/claude-structured-real-cli.test.ts src/main/claude/claude-structured-real-cli-fold.test.ts`; it uses your real Claude login

# Writing Pull Requests

Fill in [`.github/pull_request_template.md`](./.github/pull_request_template.md), written for a reviewer who has never seen this code:

- No jargon — plain language, no internal shorthand.
- The before and after as the user experiences it.
- The mechanism you changed, not just the symptom.
- Why this approach over the alternatives you considered.

Cover all four concisely. Don't pad or walk the diff.

# Considerations

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.
- **Windows terminal shells**: `--shell` picks the shell a terminal _is_; `--command` is typed into whatever shell the host spawned, so a shell choice routed through `command` silently becomes a child process. See [`docs/reference/windows-terminal-shell-selection.md`](./docs/reference/windows-terminal-shell-selection.md).
- **Windows setup scripts**: the setup/issue-command runner is a `.cmd` batch file unless the script starts with a `#!` line — never derive that from the user's terminal-shell preference, and never launch a `.cmd` runner with a bare `cmd.exe /c` from a Git Bash pane (MSYS rewrites the `/c`). See [`docs/reference/windows-setup-shell.md`](./docs/reference/windows-setup-shell.md).
- **Windows child processes**: start them through `runProcess`/`spawnProcess` in `src/shared/child-process/` — never `child_process` directly. It pins `windowsHide`, refuses `shell: true`, and encodes `.cmd`/`.bat` arguments so neither `CommandLineToArgvW` nor `cmd.exe` mangles them. A ratchet test fails on any new direct import. Recognised npm/pnpm `.cmd` shims are resolved to their real target so the spawn skips `cmd.exe` entirely; see [`docs/reference/windows-cmd-shim-resolution.md`](./docs/reference/windows-cmd-shim-resolution.md) before adding a shim shape or debugging one.
- **Ripgrep**: Orca bundles `rg` for every platform, WSL, and SSH remotes. Spawn it through `spawnBundledRipgrep` (main) or `resolveRelayRipgrepCommand` (relay), never a bare `'rg'` — Windows resolves a bare name in the spawn cwd before PATH. Don't add git/readdir fallbacks locally; the relay's chain exists only for hosts an upload never reached.
- **Windows process enumeration**: read the table through `src/main/windows/windows-process-table.ts`, never by forking `powershell.exe`. See [`docs/reference/windows-process-enumeration.md`](./docs/reference/windows-process-enumeration.md).
- **Windows MSYS/Git Bash panes**: their children break away from the per-PTY job unless it is created without `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, and a `conpty.node` built before that fix passes every existing gate. Before changing the per-PTY job or debugging `windows-msys-job.win32.test.ts`, read [`docs/reference/windows-msys-job-breakaway.md`](./docs/reference/windows-msys-job-breakaway.md).
- **Windows daemon-host relocation**: the terminal daemon runs from a copy of the app runtime under `%LOCALAPPDATA%`, which is what survives an auto-update. Before touching that copy, its exe name, or the NSIS uninstall macro, read [`docs/reference/windows-daemon-host-relocation.md`](./docs/reference/windows-daemon-host-relocation.md).
- **Windows EDR signal**: don't add `-ExecutionPolicy Bypass`, `-EncodedCommand`, `cmd.exe /c` with escaped free text, per-operation interpreter spawning, or runtime `Add-Type` compilation without reading [`docs/reference/windows-edr-posture.md`](./docs/reference/windows-edr-posture.md) first — behavioural EDR scores each of those, and being signed does not clear them. For file verdicts on the bytes we ship — antivirus false positives, and the vendor programs that clear a release before users meet the detection — see [`docs/reference/antivirus-prerelease-clearance.md`](./docs/reference/antivirus-prerelease-clearance.md).
- **WSL commands**: build argv with `buildWslExecArgs` (always `--exec` — under `--`, `wsl.exe` expands `$name` in every argument and silently rewrites the script), and fence anything whose stdout you parse with `buildWslCapturedLoginShellCommand`, because the interactive login shell prints the distro banner to stdout. See [`docs/reference/wsl-command-execution.md`](./docs/reference/wsl-command-execution.md).
- **Linux native modules**: keep the glibc floor at Ubuntu 20.04 / glibc 2.31. A module compiled from source on a newer runner can reference symbol versions absent on the floor and crash the app on startup. See [`docs/reference/linux-glibc-compatibility.md`](./docs/reference/linux-glibc-compatibility.md); packaging fails if a bundled native binary needs newer glibc.

## Native Dependency Installs

Ordinary `pnpm install` covers the host OS and CPU only. Before packaging for another architecture — including `pnpm build:mac`, which builds x64 and arm64 by default — run `pnpm install:release`. electron-builder only warns on a missing `extraResources` source, so the `beforePack` guard is what turns a thin install into a build failure instead of a silently broken artifact; see [`docs/reference/pnpm-install-policy.md`](./docs/reference/pnpm-install-policy.md).

## SSH Use Case

All changes must consider the SSH use case. Don't assume local-only execution. Before changing anything that reports on, stops, or lists remote work, follow [`docs/reference/ssh-execution-boundary.md`](./docs/reference/ssh-execution-boundary.md): the execution host owns everything that touches execution, and loss of contact is never evidence of process death — the verdict vocabulary is `live` / `unverifiable` / `exited`, with no synonyms.

## Folder Workspace Use Case

All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree.

## Agent Status

The execution host owns agent status in one store, the hook server's, and every reader (sidebar, `worktree ps`, mobile, dashboard) subscribes to it. Before adding a producer, a cache, or a reader-side precedence rule, read [`docs/reference/agent-status-store.md`](./docs/reference/agent-status-store.md): new producers write into that store, and readers keep only presentation policy.

## Agent Terminal Screens

A rule that reads what an agent CLI paints on a terminal — readiness, blocked prompts, idle — must be written against a captured transcript, not a remembered screen. Record one with [`docs/reference/agent-pty-transcript-capture.md`](./docs/reference/agent-pty-transcript-capture.md), which keeps escapes and wrapping intact and scrubs account identifiers before they reach git. Antigravity readiness has no transcript yet and five failed attempts without one; before touching it, read [`docs/reference/antigravity-readiness-evidence.md`](./docs/reference/antigravity-readiness-evidence.md).

## Remote Wire Compatibility

Clients and remote Orca servers update independently, so mixed versions are the normal state. Before changing anything a paired client and host exchange — RPC params, stream frames, or the content either side publishes over them — follow [`docs/reference/remote-wire-compatibility.md`](./docs/reference/remote-wire-compatibility.md). A new optional field is safe; a new stream opcode must be capability-negotiated because decoders drop unknown opcodes silently; and changing what the host publishes reaches old clients even with no wire change.

## Git Binary Compatibility

Orca runs the user's Git binary on native, WSL, and SSH hosts, which may all have different versions. Treat Git 2.25 as the core-workflow baseline and follow [`docs/reference/git-compatibility.md`](./docs/reference/git-compatibility.md).

When adding or changing a Git command:

- Check when every subcommand and option was introduced. For newer behavior, keep a baseline-compatible fallback or degrade safely.
- Use `GitCapabilityCache` with a narrow unsupported-error predicate so recurring operations do not retry a known-invalid command. Do not rely only on `git --version`; wrappers such as `simple-git` do not remove host-version differences.
- Scope capability state to the host that executes Git: native, WSL distro, SSH provider, or relay connection. Cover the first fallback, later cached calls, concurrent probes, and relevant host isolation in tests.
- Keep the real-binary compatibility contract in PR CI current. When adopting a newer Git feature, add its version boundary so the preferred command and fallback both run against representative Git releases.
- Preserve commands that begin with global Git options such as `-c` before the subcommand, including auto-maintenance suppression used by worktree-create fetches.

## Git Scan Safety

- Never enumerate every ref and then run `git ls-tree -r` or `git show` once per ref. That ref × tree fan-out can retain gigabytes of output before a downstream `sort -u` or search can make progress.
- Prefer `rg` over the checked-out files for source searches. For history or refs, use a named ref, an explicit namespace/path, `--max-count`, and a bounded output; do not use an unqualified `--all` scan as a first diagnostic.
- Keep repository-wide commands targeted to the current repository and worktree. If an unbounded scan is genuinely required, measure the ref count first, explain the cost, and get confirmation before running it.

## Git Provider Compatibility

Source-control and review changes must consider GitLab and other supported git providers, not only GitHub. Keep provider-specific behavior behind explicit checks, and avoid GitHub-only naming for generic review concepts.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.
<!-- ORCA:CANONICAL_RULES:START -->
<!-- CANONICAL_POLICY_VERSION: 1.4.1 -->
<!-- CANONICAL_RULESET_HASH: 02dff264f3a046d83ab8fa3578ee03dd142bd4614af9d78caed329ff9eb84cbb -->
## Canonical cross-project routing policy

## 1. Authority & Roles

### CANON-R001 — Authority and Lead role [MUST v2]

PO/user retains final authority. Lead is a ROLE, not a model. Changing the model assigned to Lead MUST NOT change orchestration semantics. Workers do not orchestrate Workers. Project-local policy may only narrow canon; each project remains authoritative for its product/domain rules.

### CANON-R013 — Worker topology [SHOULD v1]

Default worker topology is `Lead → Worker → Lead checkpoint → Worker`.

### CANON-R011 — Watchdog boundary [MUST v1]

Watchdog authority is limited to `observe → reconcile → classify → wake/surface`. It has no coordinator, product, or model-selection authority.

### CANON-R017 — Lead fallback [MUST v1]

Lead fallback requires `LEAD_FALLBACK_REASON=<reason>`. A fallback Lead still uses cheapest capable workers.

## 2. Governed Agent Pool

### CANON-R030 — Governed Agent Pool [MUST v1]

The current governed agent pool is exactly Codex / GPT, Claude Local, OpenCode, and Antigravity / AGY. Pool membership determines which agent surfaces may be automatically dispatched, not their task capability or concrete model mapping. Capability lanes determine capability; runtime maps them to concrete models without exact-version binding. Only pool members may enter automatic worker/reviewer dispatch; membership alone does not establish capability, eligibility, capacity authorization, or readiness. Adding or removing a surface is a durable PO-approved canonical change.

## 3. Execution Mode: Lead vs Tool vs Worker

### CANON-R002 — Execution mode before routing [MUST v4]

Choose execution mode BEFORE routing: Direct Lead, Tool, or Worker. Worker-first is not worker-mandatory. Direct Lead is allowed for small, bounded, local, deterministic work where dispatch overhead is disproportionate. Trivial work needs no `DIRECT_EXECUTION_REASON`; substantive direct work or possible bypass requires `DIRECT_EXECUTION_REASON=<reason>` explaining the bounded scope and overhead. Direct Lead MUST NOT bypass failed dispatch, readiness refusal, provider failure, failed/missing capacity handshake, failed Watchdog registration, or independent review (`CANON-R027`). Tool mode uses sufficient deterministic/specialist tools before LLM dispatch; tools provide evidence, caller owns the task. Only substantive delegated agent work enters governed worker routing/lifecycle. Read-only work, trivial initialization, tiny direct Lead work, deterministic tools, and Jev tool calls do not require worker capacity/readiness gates merely because a Run exists.

## 4. Tool Pool & Jev

### CANON-R031 — Tool Pool and Jev [MUST v1]

Use deterministic/specialist tools when sufficient before dispatching an LLM. Jev is a bounded structured-decision tool exposed through the certified surface `orca jev decide`. Consider Jev before dispatching an LLM solely to make the same bounded predetermined-schema decision: classification, yes/no, finite choice, scoring/rating, guardrail/policy check, structured evaluation. Exclude code/repo work, architecture, free-form research/synthesis, arbitrary prose/docs, Lead decisions, and generic independent review. Jev is NOT an agent, Worker, Reviewer, Lead, terminal/session route, or `RUN_ROUTING_POSTURE` route. Its output is evidence; the caller owns the next action. Jev failure/timeout permits no automatic retry or worker fallback. Usage/cost is tool accounting/observability, not worker-route capacity. Current balance, model, pricing, credentials, and spend stay outside canon.

## 5. Task Classification & Capability Lanes

### CANON-R022 — Capability lane baseline [MUST v3]

Classify work by capability; lanes are not immutable provider/model bindings. Runtime maps lanes to concrete models (`CANON-R020`); lanes do not bind the Lead role (`CANON-R001`). (1) Routine/mechanical — no named profile: mechanical edits, deterministic refactor, boilerplate, straightforward tests, parsing/extraction, routine doc transforms, repetitive clear-rule changes and small implementation with deterministic acceptance. It surfaces ambiguity as `OPEN` or `CONFLICT`, never self-promotes to Lead, and is not primary consequential reviewer without demonstrated review capability. (2) Diagnostic/reasoning/bounded review — profile may be DeepSeek-class or equivalent: debugging, root cause, adversarial inspection, bounded technical reasoning, repo analysis, qualified technical review; do not use it for routine work the routine lane can do. (3) Substantial implementation — profile GPT/Codex-class or equivalent: complex/multi-file coding, integration-heavy and architectural implementation. (4) High-value cognition — profile Claude-class or equivalent: source-heavy research, legal/tax synthesis, ambiguous requirements, architecture reasoning, high-value integration judgment; not default for routine edits or basic debugging. Consider every prima facie capable pool member, subject to eligibility. Risk raises rigor, not lane tier (`CANON-R003`). Lanes create no quota or authority; preserving scarce capacity MUST NOT be treated as `PRESERVED`.

## 6. Route Selection — Cheapest Capable + Eligible

### CANON-R004 — Cheapest capable and eligible first [MUST v3]

For delegated execution, build the candidate set from task capability (`CANON-R022`), not reputation or Lead preference. Consider every prima facie capable member of the governed pool (`CANON-R030`). Use the cheapest capable + eligible route first. A stronger, more expensive, or available route alone is no justification. Escalation needs evidence that the cheaper route cannot perform the work or a specific capability requirement; normal cheapest-capable selection needs no verbose justification.

### CANON-R005 — Intentional cheaper-route bypass [MUST v3]

Record `CHEAPER_ROUTE_BYPASS_REASON=<specific capability gap>` only when intentionally skipping a cheaper capable + eligible route, including a prima facie capable routine lane. The reason must substantiate the bypass. Importance, high risk, stronger is safer, reputation, availability alone, reviewer preference, faster, convenience, capacity-share or allocation balancing are not justification.

### CANON-R016 — Compatibility escalation accounting [MUST v3]

`SOL_ESCALATION_REASON=<specific capability requirement>` is retained only for runtime compatibility accounting where a high-tier escalation requires it. This does not bind generic routing to a named model or exact version. Capability and eligibility govern selection; existence, availability alone, importance, high risk, stronger is safer, and Lead preference do not justify escalation. Merely holding the Lead role does not require this field (`CANON-R001`, `CANON-R017`).

## 7. Risk vs Complexity vs Model Strength

### CANON-R003 — Risk and complexity separation [MUST v1]

`RISK != COMPLEXITY != MODEL STRENGTH`. Risk controls rigor; complexity and capability control model/route. High consequence does not mean high complexity: high-risk mechanical work may use a cheap bounded worker with stricter testing and review.

## 8. Capacity & Readiness

### CANON-R024 — Run-start capacity handshake [MUST v2]

Before the first substantive delegated agent dispatch in a new Run, Lead MUST complete a run-start capacity handshake: (1) use the latest shared runtime capacity snapshot (Meter/Watchdog) when it is fresh enough; (2) if it is missing or stale, request at most one bounded refresh; (3) if the refresh fails, use the last-known snapshot only while it is within the configured acceptable stale window; otherwise record capacity observation as `UNKNOWN` rather than guessing. Freshness and stale windows are runtime configuration, not canonical values. Lead MUST NOT poll providers, loop refreshes, or block trivial non-substantive initialization on quota discovery (`CANON-R007`, `CANON-R012`). The snapshot is a normalized runtime record: snapshot id, observed time, source, confidence, and per route: family, route identity, availability observation, zero or more capacity dimensions (remaining amount; unit such as percent, tokens, requests, or monetary balance; window such as rolling, daily, weekly, or none; reset time), cost/balance state, runtime mapping, reservation qualifier, and observation status. Providers without a direct quota metric are represented as such and MUST NOT be forced into a synthetic percentage. A failed or missing observation is `UNKNOWN`: it MUST NOT be inferred as exhausted quota, `UNAVAILABLE`, provider failure, or task failure; availability is assessed from separate evidence (`CANON-R010`). This follows the same non-inference discipline as `OUTCOME_UNKNOWN` (`CANON-R008`) without merging the two states. Snapshot contents are runtime state and never become canonical policy (`CANON-R020`). Record `RUN_CAPACITY_SNAPSHOT_ID=<snapshot id|UNKNOWN>` (`CANON-R019`). This applies to substantive delegated agent dispatch, not read-only work, trivial initialization, tiny direct Lead work, deterministic tools, or Jev tool calls. These mode exemptions are defined in `CANON-R002`.

### CANON-R007 — One bounded readiness check [MUST v2]

For substantive delegated agent dispatch, perform at most one bounded readiness check (`CANON-R028`). Do not run provider discovery or polling loops. This gate does not unnecessarily apply to read-only work, trivial initialization, tiny direct Lead work, deterministic tools, or Jev calls.

### CANON-R028 — Dispatch requires operational readiness [MUST v2]

`AVAILABLE` capacity is not operational readiness. Substantive delegated agent dispatch requires policy eligibility (governed pool and durable local restrictions) + Run-handshake capacity authorization (`CANON-R024`) + readiness recorded `READY` by the one bounded check (`CANON-R007`). `AVAILABLE` + `NOT_READY`, `UNKNOWN`, or unrecorded readiness MUST fail closed: machine-readable refusal, zero provider side effect, zero worker creation. Readiness is runtime evidence (`CANON-R020`). Runtime/Meter/Watchdog/transport MUST NOT choose a replacement. Lead may choose the next cheapest capable + eligible route on definite refusal, recording `ROUTING_FALLBACK_REASON`; a definite refusal is not `OUTCOME_UNKNOWN`. These gates apply to substantive delegated work, not read-only work, trivial initialization, tiny direct Lead work, deterministic tools, or Jev calls.

### CANON-R023 — Capacity targets are not routing quotas [MUST_NOT v1]

Capacity/model-share targets are observability and portfolio-health guidance only. They MUST NOT force dispatch; force reviewer selection; cause use of an incapable or ineligible model; cause bypass of a cheaper capable + eligible lane; or trigger balancing solely to reach target percentages. Capability + eligibility always override target distribution. Numeric targets are runtime/operational configuration, not canonical policy (`CANON-R020`). Observers such as Orca Meter may measure and report route shares but gain no routing authority from target percentages (`CANON-R011`).

## 9. Governed Dispatch & Lifecycle

### CANON-R027 — Governed substantive execution [MUST v1]

Substantive execution by a worker, reviewer, additional agent, or delegated model/provider for a governed Run MUST go through governed Orca dispatch (`CANON-R018`, `CANON-R024`). Bounded direct Lead execution remains governed by `CANON-R002` alone and is never a workaround for a missing or failed capacity handshake, unavailable governed dispatch, failed Watchdog registration, a readiness refusal (`CANON-R028`), a worker launch failure, or a provider failure; those outcomes MUST stay visible as failures or refusals and MUST NOT be converted into direct provider execution. A governed Run MUST NOT substitute an external provider or agent CLI launch, or an Orca agent-launch surface outside governed dispatch, for a worker, reviewer, or additional agent. This binds Orca-owned and Orca-controlled delegated execution; it does not restrict human shell use, and no component claims to prevent execution outside Orca's technical control boundary.

### CANON-R018 — Governed dispatch evidence [MUST v1]

Governed dispatch evidence MUST preserve `agent identifier != model identifier` and the distinction between requested and effective routes.

### CANON-R012 — Event-driven lifecycle [MUST v2]

For substantive delegated execution use `classify → capacity → readiness → run-create → watchdog watch → dispatch → yield → wake/event → collect → decide → next dispatch if needed → yield → close → unwatch`. Establish governed watch before dispatch. No babysitting: no sleep/check loops, worker-output polling strategy, or CI/provider polling when an event/Watchdog path exists. Close/unwatch on completion; workers are not replaced solely because capacity changes.

## 10. Failure / UNKNOWN / Retry / Fallback

### CANON-R008 — OUTCOME_UNKNOWN fail-safe [MUST_NOT v1]

For `OUTCOME_UNKNOWN`, prohibit assumed failure; assumed success/completion; automatic `FAILED`; automatic `DONE`; retry; redispatch; replacement; and automatic fallback.

### CANON-R009 — Silence and time are not failure [MUST_NOT v1]

Do not infer failure or escalate from silence, elapsed time, or ambiguous TUI activity.

### CANON-R006 — Evidence-backed fallback [MUST v2]

Lead owns fallback. Actual fallback requires positive evidence of incapability, ineligibility, unavailability, or definite failure/refusal and `ROUTING_FALLBACK_REASON=<evidence-backed reason>`. No automatic retry, redispatch, replacement, or fallback. Runtime, Meter, Watchdog, and transport do not choose replacements. `OUTCOME_UNKNOWN`, silence, elapsed time, or ambiguous output provide no fallback evidence.

## 11. Validation & Independent Review

### CANON-R014 — Validation and consequential independent review [MUST v3]

Prefer deterministic verification before additional LLM work: tests, typecheck, lint, build, schema, diff, and static checks as appropriate. Consequential changes require independent review: security, finance, auth/credentials, destructive migrations, routing/governance, production architecture, and high-impact business logic. The author MUST NOT self-review. Trivial typo, formatting, or mechanical deterministic edits do not require independent review unless project-local policy narrows further.

### CANON-R015 — Cheapest capable reviewer [MUST v2]

Independent review follows cheapest-qualified-capable semantics over reviewers that are qualified, independent of the author, and eligible. Author→reviewer pairings are non-binding preference hints, not permanent fixed vendor routing. Bounded technical review defaults to the diagnostic/review lane when that lane is qualified and independent. The routine lane is not primary reviewer for consequential work without demonstrated review capability. Bypassing a cheaper qualified reviewer for a premium reviewer requires `CHEAPER_ROUTE_BYPASS_REASON=<specific review capability reason>`.

## 12. Routing Reasons & Accounting

### CANON-R019 — Applicable routing accounting [MUST v4]

Accounting supports existing fields where applicable: `REQUESTED_ROUTE`, `EFFECTIVE_ROUTE`, `ROUTE_REASON`, `CHEAPER_ROUTE_BYPASS_REASON`, `ROUTING_FALLBACK_REASON`, `DIRECT_EXECUTION_REASON`, `LEAD_FALLBACK_REASON`, `RUN_CAPACITY_SNAPSHOT_ID`, and `RUN_ROUTING_POSTURE`. `SOL_ESCALATION_REASON` is compatibility-only (`CANON-R016`). `ROUTE_REASON` SHOULD identify the task class and posture when reservation affects ordering. Bypass reasons apply only to intentional bypass, fallback reasons only to actual fallback, direct reasons only to substantive direct work or possible bypass. Normal cheapest-capable execution needs no verbose justification. Jev usage/cost is tool accounting/observability, not worker-route capacity; no new fields are required.

## 13. PRESERVED / RUN_RESERVE

### CANON-R010 — Availability states [MUST v3]

Use availability states `AVAILABLE`, `CONSTRAINED`, `PRESERVED`, and `UNAVAILABLE`. `PRESERVED` is a hard exclusion for execution, review, fallback, and emergency routing within the explicitly instructed Run/task scope until the Product Owner or user explicitly lifts it; it MUST NOT become permanent provider state or carry into later Runs automatically. Only explicit Product Owner/user instruction sets `PRESERVED`; Lead, Meter, Watchdog, and capacity thresholds MUST NOT. Runtime capacity reservation is `RUN_RESERVE` (`CANON-R025`), not `PRESERVED`.

### CANON-R025 — Capacity reservation is runtime routing state [MUST v1]

Capacity reservation is runtime-only routing state. Lead derives a Run-scoped `RUN_ROUTING_POSTURE` from canonical lane semantics (`CANON-R022`), current availability evidence, the run-start snapshot (`CANON-R024`), explicit PO/user `PRESERVED` instructions, and the configured capacity-reservation policy. For each route the posture records availability state and a `RUN_RESERVE` qualifier (`NONE` or `HIGH_VALUE_ONLY`). `RUN_RESERVE` is not `PRESERVED` (`CANON-R010`): a reserved route remains `AVAILABLE` or `CONSTRAINED` and eligible. Reservation may only order a reserved route after capable + eligible non-reserved routes that are no more expensive, for work that does not genuinely require its capability. It MUST NOT make an incapable or ineligible route eligible; block a route whose capability the task genuinely requires; justify skipping a cheaper capable + eligible route or escalation (`CANON-R004`, `CANON-R005`); create fixed model quotas; alter lane semantics; or confer Product Owner authority. `UNKNOWN` capacity observation creates neither reservation nor unavailability. Reservation thresholds are runtime configuration; changing them requires no canonical change. Unlike capacity-share targets (`CANON-R023`), which are aggregate portfolio-health guidance, reservation reflects current capacity evidence for this Run. Posture applies to future dispatches only. On a meaningful capacity transition (threshold crossed, quota reset, route restored or unavailable, snapshot materially stale), Watchdog MAY detect, reconcile, classify, and wake/surface Lead; it MUST NOT choose a replacement route, rewrite the posture, kill a worker, or redispatch (`CANON-R011`). Lead then recomputes the posture for future dispatches; a running worker MUST NOT be killed, restarted, or replaced solely because capacity or reservation changed. Authority boundary: Orca Meter may own normalized capacity snapshots, token/cost accounting, balance/budget observation, historical samples, configured reservation thresholds, and reporting, but not routing, dispatch, reviewer selection, or Product Owner authority. Watchdog may own bounded refresh scheduling, staleness and transition detection, and event emission/wake, but not routing decisions, automatic provider fallback, `PRESERVED` assignment, or quota-driven worker replacement. Lead owns the posture, its interpretation alongside capability and eligibility, and the next dispatch decision. Record `RUN_ROUTING_POSTURE` (`CANON-R019`).

## 14. Durable Policy vs Runtime State

### CANON-R020 — Durable policy versus runtime state [MUST v4]

Never encode or propagate current quota/balance, outage, temporary workhorse/provider disablement, concrete model mapping, readiness incident, KYC/billing/account state, Jev spend/balance/model/pricing/credentials, or snapshot IDs as canonical values. These are runtime state, not durable policy. Canon owns pool membership, capability and routing semantics, never observed provider state. Local overlays hold durable restrictions only and may only narrow canon; the `MODEL_CAPACITY` block is a contract, not a snapshot.

### CANON-R026 — Temporary capacity is not project-local policy [MUST_NOT v1]

Project-local policy outside the managed blocks holds durable routing restrictions only: manual-only or governed-readiness restrictions, compliance restrictions, project-specific capability restrictions, task-class prohibitions, and explicit long-lived Product Owner restrictions. Temporary capacity state MUST NOT be recorded as project-local policy: quota or balance levels, exhaustion, rate limits, provider outages, temporary disablement, overrides that last until re-enable or until a reset, and preservation motivated by low quota belong to the runtime capacity layer (Orca Meter snapshot, `CANON-R024`) or to the current explicit PO/user instruction for the Run (`CANON-R020`). Lead MUST NOT treat a route as `UNAVAILABLE`, exhausted, or `PRESERVED` solely because project-local text records temporary capacity state; route availability for a Run comes from explicit current PO/user instruction and the run-start handshake, while durable local restrictions continue to narrow eligibility. When such text conflicts with the handshake, Lead follows the handshake and surfaces the conflict. Stale temporary capacity text is removed only by an explicitly PO-authorized exact edit; text that cannot be classified as temporary or durable is surfaced for Product Owner review and is never silently reinterpreted or deleted.

## 15. Propagation Rules

### CANON-R032 — Safe deterministic propagation [MUST v1]

Propagation remains deterministic, reviewable, and available as a dry run. Only registered `sync_mode=auto` projects authorize automatic managed-block commit/push after all safety, canonical-branch, cleanliness, validation, idempotence, commit-integrity, and push-verification gates pass. A failed gate defers/blocks without mutation; never force consistency. `manual` projects are report-only; `disabled` are excluded from automatic propagation. Writes are confined to `CANONICAL_RULES` and `MODEL_CAPACITY`; a missing capacity block may be installed directly after rules. Local overlays and product/domain rules remain untouched, except explicit PO-authorized registry `capacity_migrations` matching exact stale temporary capacity text once outside managed blocks (`CANON-R026`). Ambiguous text/conflicts require PO/Lead review, no mutation. Dirty/non-canonical repositories defer/block; never stash, reset, clean, force-push, switch branches, or write another checkout. Never propagate runtime provider state. `MODEL_CAPACITY` remains a contract, not a snapshot. This does not relax other Git/deployment safeguards.

<!-- ORCA:CANONICAL_RULES:END -->

<!-- ORCA:MODEL_CAPACITY:START -->
<!-- MODEL_CAPACITY_CONTRACT_VERSION: 2 -->
<!-- MODEL_CAPACITY_HASH: bb590f2067e3fa6cc46a29d8d5c49c9955e79d6a1acaafb459bf30d0bfa83251 -->
## Model capacity (machine-managed contract)

This block is a capacity contract, not a capacity observation: it never carries quota, balance, or availability values and never governs a Run on its own.

- Capacity source: Orca Meter normalized snapshot (`orca-meter-capacity snapshot`; contract `capacity_snapshot.schema.json` v1).
- Before substantive delegated agent dispatch (`CANON-R024`): read the latest snapshot once; if it is missing or stale, run at most one `orca-meter-capacity refresh`; no polling and no retry loop. A repeated Run start reuses the recorded `RUN_CAPACITY_SNAPSHOT_ID`. Read-only work, trivial initialization, tiny direct Lead work, deterministic tools, and Jev calls do not require this handshake.
- Observation: `FRESH` (`observation_status=OBSERVED`), `STALE`, or `UNKNOWN`. Per-route state comes only from the snapshot: `AVAILABLE`, `CONSTRAINED`, `UNAVAILABLE`, or `UNKNOWN`. A failed or missing observation stays `UNKNOWN` and is never `UNAVAILABLE`.
- Authority flow: explicit current PO/user instruction → Run capacity handshake → `RUN_ROUTING_POSTURE` (`CANON-R025`) → canonical routing rules → durable project-local restrictions, which always narrow eligibility.
- Temporary capacity state (quota, balance, outage, until-re-enable overrides) never lives in project-local text; such text does not govern routing (`CANON-R026`).

PO-preserved routes (explicit PO/user instruction only, `CANON-R010`):

- none
<!-- ORCA:MODEL_CAPACITY:END -->
