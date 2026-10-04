# Orca MK bundled CLI

Orca MK owns its CLI distribution. The macOS launcher is
`Orca MK.app/Contents/Resources/bin/orca`; it runs the adjacent desktop executable
in Node mode with `app.asar.unpacked/out/cli/index.js`. It never loads a global CLI.
The shell selector at `~/.local/bin/orca` points to an MK-owned forwarding shim at
`~/.local/state/orca-mk/bin/orca`, which executes this exact bundled launcher.
Legacy official installers treat the protected shim as a conflict; MK installers
recognize it and never reclaim official app selectors.
The official `/Applications/Orca.app` and `/opt/homebrew/bin/orca` are unchanged.

## Build and package contract

`pnpm build:mac` chooses one local version and signing environment before running
`build:desktop`. Both CLI and main builds record their source commit, source
fingerprint (including uncommitted source changes), distribution, protocol range,
and artifact hashes. MK packaging refuses missing, changed, or mismatched build
receipts. It checks the copied CLI and shared modules and requires an executable
launcher before signing. `Resources/orca-build-identity.json` is the shared
runtime/CLI identity; the existing `out/package.json` carries the effective version.

The protocol numbers come from `src/shared/protocol-version.ts`. Runtime status
publishes optional `buildIdentity`, so existing clients can ignore it. `orca doctor`
reports runtime and CLI metadata and the invoked CLI path. Governed operations
refuse incompatible or unknown protocol ranges with `CLI_RUNTIME_MISMATCH` before
mutation. Compatible protocol ranges do not require identical version strings.
MK CLI commands require a runtime identifying itself as MK. Offline help and
`--version` do not connect to a runtime. No MCP bridge compatibility is inferred.

The launcher is a shell resource sealed by the app signature; it does not need a
separate Mach-O signature. Existing helper signing, strict app signature checks,
and release notarization requirements remain in force. Local MK uses the existing
local development signing path.

## Selector migration and rollback

After installing a verified MK bundle at `/Applications/Orca MK.app`:

```sh
pnpm build:cli  # supplies the existing native filesystem transaction module
node config/scripts/mk-cli-selector.mjs
```

An existing selector targeting official Orca is reported and left intact. Explicit
migration is available with `--replace-existing-selector`. This option preserves
the previous symlink target in `~/.local/state/orca-mk/cli-selector.json`; it never
replaces a regular executable. Installation verifies the MK app identifier and
strict code signature, then uses the native installer’s inspected-entry/quarantine transaction to change
only the user-level symlink without overwriting a racing foreign entry.
Repetition is idempotent. Updates at the same app path need no selector rewrite.
An explicit `--app=/absolute/path/Orca\ MK.app` supports other local bundle paths.

```sh
rehash  # zsh; use hash -r in bash
which -a orca
type -a orca
orca doctor --json
node config/scripts/mk-cli-selector.mjs --rollback
```

Rollback restores the original target, or removes a selector that was newly
created. It refuses to overwrite a selector another program changed afterward.
Long-lived shell command caches may require rehashing; automation with an absolute
official CLI path must deliberately opt into MK. No launcher can override an
absolute executable path or an `orca` alias/function.

Before accepting a migration, use plain `orca` to register capacity evidence and
perform a bounded governed dispatch with the existing canonical commands
`orchestration run-capacity-record` and `orchestration worker-start`. Capacity and
routing policy are unchanged by CLI alignment.
