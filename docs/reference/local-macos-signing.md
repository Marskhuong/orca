# Local macOS signing for Orca MK

`pnpm build:mac` packages `com.stablyai.orca.mk` with a stable development
certificate. It requires `ORCA_MAC_LOCAL_SIGN_IDENTITY`, the certificate's SHA-1
fingerprint. Ad-hoc signing is refused because its designated requirement changes
with build contents and stops matching existing Keychain authorizations.

List available certificates with private keys:

```sh
security find-identity -v -p codesigning
```

Choose an existing personal `Apple Development` certificate, or a dedicated
`Orca MK Local Development` code-signing certificate in the login Keychain.
Never select Lovecast or a production distribution identity. The wrapper rejects
production identities and clears inherited `CSC_*` certificate settings.

Set the chosen fingerprint in your local shell configuration, outside the repo:

```sh
export ORCA_MAC_LOCAL_SIGN_IDENTITY='<40-character SHA-1 from find-identity>'
pnpm build:mac --arm64 --dir
```

Use the same fingerprint for later builds. Missing or unavailable identities fail
the build instead of falling back to ad-hoc signing. For cross-architecture builds,
follow [the native install policy](pnpm-install-policy.md) first.

MK and its helpers use the selected certificate. Local builds retain empty
entitlements, skip timestamping and notarization, and keep the separate `Orca MK Safe Storage` /
`Orca MK Key` namespace. Switching from a previous ad-hoc build may require one
Keychain authorization for the new certificate; future builds should match that
same certificate requirement. Do not delete credentials to resolve that prompt.
Official `/Applications/Orca.app` and its credentials are independent.
