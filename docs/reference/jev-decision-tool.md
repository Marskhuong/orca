# Jev structured decision tool

`orca jev decide` makes one bounded TypeSafe decision on the execution host. It is a
shared tool for terminal-backed Leads and Workers, not a worker route. It creates no
Run, dispatch, terminal, session or worker completion event. It never selects another
model or dispatches a replacement worker.

## Interface

Supply JSON on stdin or with `--input <file>`. Stdout is JSON, including on failure.

```sh
printf '%s\n' '{"state":{"lamp":"on"},"questions":[{"type":"noul","instructions":"Is the lamp on?"}]}' | orca jev decide
orca jev usage
```

`state` is a string, object or array. Questions use the provider's native `noul`,
`choice` or `score` schema. Native named question objects are accepted; array entries
are named `q0`, `q1`, and so on before sending. Object keys are serialized in sorted
order; arrays preserve order. Input and response bodies are limited to 256 KiB.

The default model is pinned to `jev-1.13.0`. An explicit supported Jev model or alias
can be supplied as `model` in the JSON. A version-pinned request rejects a different
reported model. Explicit `jev-latest` / `jev-preview` aliases accept the provider's
reported resolution. There is no fallback. Answer names, types, probability ranges,
choice membership and score rubrics must match the request.

The [official OpenAPI contract](https://api.typesafe.ai/openapi.json) defines the
request and response. This tool makes exactly one `POST /v1/systemone`, using direct
HTTP rather than an SDK that might retry. The 20-second abort deadline covers the
request and response body. It refuses redirects. Input from stdin has a separate
three-second deadline. Credentials are read before the provider request.

Success includes `status: succeeded`, `requestId`, `retryable: false`, `durationMs`,
`effectiveModel`, native typed `answers`, unaltered provider `usage` counts and
`accounting`. Failures use `failed` or `outcome_unknown`, `retryable: false`, and a
fixed error code. Timeout, network ambiguity, malformed responses and model mismatch
are never successful decisions. HTTP authentication errors are `AUTH_FAILED`;
missing credentials are `AUTH_REQUIRED`. Provider error bodies, request contents and
credentials are never copied into diagnostic output. The caller decides its next
step; no failure triggers automatic worker fallback.

## Credentials and host boundary

The command reads `TYPESAFE_API_KEY`, or on macOS the existing Keychain item with
service `Orca MK JEV API` and account `JEV_API_KEY`. Optional
`ORCA_JEV_KEYCHAIN_SERVICE` / `ORCA_JEV_KEYCHAIN_ACCOUNT` select another existing item.
It does not write credentials or alter Keychain access policy. Secret bytes are sent
only in the Authorization header, not subprocess arguments, files or logs.

The same installed CLI and credential source work for Lead and Worker terminals.
Run this command on the intended host; it does not forward credentials or RPC through
Orca. Explicit remote-selection flags are rejected. It works without a running
Desktop and does not query runtime metadata. Folder workspaces and git worktrees use
the same tool interface.

## Accounting boundary

Successful validated replies write a sanitized, owner-readable record under the
execution host's Orca user-data directory in `jev-tool-usage`. For isolated accounting,
set `ORCA_JEV_USAGE_DIRECTORY`. Records contain request identity, timestamp, effective
model, usage, duration and pricing; they omit state, questions, answers and credentials.
Exclusive per-request files avoid duplicate insertion. `orca jev usage` deduplicates
request identities and reports rejected records without blocking other providers.
A failed journal write leaves the decision successful but reports `recording_failed`.
Unknown/outcome-unknown calls are not accounted as successful calls; the provider may
have billed an ambiguous request. This is locally observed spend, not a billing ledger.

[Published TypeSafe model pricing](https://docs.typesafe.ai/models), verified on
2026-10-05, prices `jev-1.13.0` at $0.042 per million input tokens with free output.
Cost is estimated with integer nanodollars. Unknown model prices are withheld.
Cumulative totals cover only recorded calls through this tool, not console or external
usage. Orca Meter is unchanged: Jev is absent from route/capacity snapshots and no
balance endpoint is invented. Remaining balance is `NOT_AUTOMATED`; account credit
balance requires the supported account/console interface.

### Manual balance calibration

```sh
orca jev balance set --amount 10.00 --json
orca jev usage
```

Enter the current USD balance shown in the TypeSafe console, including after a top-up.
The owner-readable `balance-baseline.state` stores this manual value and the identities
of journal records already present. Footer `U` is estimated tracked spend from records
added after calibration; `R` is the calibrated value minus that spend. Recalibration
starts `U` at zero and excludes historical records without deleting lifetime usage.
An in-flight call recorded after calibration counts as subsequent spend. External calls,
unrecorded calls and provider pricing differences can make this estimate diverge from
the console; recalibrate to correct it. Negative remaining values are not clamped.

`jev usage` reports this separately as `calibratedBalance` with `manual_calibrated`
provenance. Missing or invalid baselines and unpriced/malformed accounting records hide
the footer balance rather than fabricate a value. No provider balance API is claimed,
and calibration performs no inference or credential lookup.

### Compact footer

Quota footer percentages always mean remaining, while detailed views retain their
display preference. Real 5-hour and weekly windows render as `5h 60% · 2h15m | W 59%
· 4d20h`; missing windows or reset timestamps have no placeholder. For independent
Antigravity pools, the footer shows only the pool containing the highest-consumed
window. Stable `P1`/`P2` indices follow sorted pool names; full names and all pools remain
in details. Windows from different pools are never combined.

DeepSeek `U` and `R` read the existing local Orca Meter USD ledger: used is opening
balance plus additions minus the last observed remaining balance (floored at zero,
matching Meter). The observation timestamp remains available in details. Jev uses the
manual calibration above. Both format USD to two decimals and share the existing
collapse/refresh surface. Missing Meter data is hidden; the renderer makes no duplicate
provider request.

## Suggested future policy wording

Before dispatching an LLM solely for a bounded structured decision, consider this
shared tool for classification, yes/no judgments, finite choice, rubric scoring,
policy checks or structured evaluation. The caller must interpret probability and
confidence and retain responsibility for consequential actions. Use deterministic
code for exact arithmetic.

Jev is not a code-generation, repository-editing, free-form research, synthesis,
architecture, prose-generation or Lead capability. It can support review only when
the review question itself has a predetermined bounded answer schema. This document
does not change canonical AGENTS policy or establish a Jev worker lane.
