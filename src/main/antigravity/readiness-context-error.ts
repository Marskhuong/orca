export type AntigravityReadinessContextReason =
  | 'unsupported_context'
  | 'unsupported_proxy'
  | 'unsupported_launch_configuration'
  | 'unsupported_provider_environment'
  | 'unsupported_cli_path'
  | 'missing_executable'
  | 'unsupported_binary'
  | 'missing_consumer_identity'
  | 'selected_account_mismatch'
  | 'startup_plan_unavailable'
  | 'identity_changed'
  | 'unsupported_provider_configuration'
  | 'unsupported_credential_storage'
  | 'configuration_limit'
  | 'unsupported_configuration_symlink'
  | 'unsupported_settings'
  | 'unsupported_configuration_file'
  | 'unsupported_configuration_reference'

export class AntigravityReadinessContextError extends Error {
  readonly readiness: 'UNKNOWN' | 'NOT_READY'

  constructor(readonly reason: AntigravityReadinessContextReason) {
    super(reason)
    this.name = 'AntigravityReadinessContextError'
    this.readiness =
      reason === 'missing_executable' ||
      reason === 'missing_consumer_identity' ||
      reason === 'selected_account_mismatch' ||
      reason === 'unsupported_cli_path' ||
      reason === 'startup_plan_unavailable'
        ? 'NOT_READY'
        : 'UNKNOWN'
  }
}
