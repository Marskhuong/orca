import { AntigravityReadinessContextError } from './readiness-context-error'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { prependOrcaCliDirToChildPath } from '../cli/orca-cli-child-path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { antigravityConfigurationDigest } from './native-readiness-configuration'
import { antigravityConsumerAuthorityDigest } from './native-readiness-credential-authority'
import { buildNativeAntigravityReadinessLaunchCommand } from './native-readiness-launch-command'
import { ANTIGRAVITY_READINESS_MODEL } from './headless-readiness-response'

const AUDITED_BINARIES = new Set([
  '7dca095cfc1df2c057a385ed88a76c7ba98dc103258a80be87a8f42e484cb3aa',
  '132ef8e1c0cba05e9a8259c4ee10ce30375ab93656bf71fa9ec255c7ba292611'
])
const MAX_BINARY_BYTES = 256 * 1024 * 1024
export type NativeAntigravityReadinessContext = {
  runId: string
  generation: number
  fingerprint: string
  program: string
  cwd: string
  env: Record<string, string>
  command: string
  launchConfig: NonNullable<ReturnType<typeof buildAgentStartupPlan>>['launchConfig']
}

export async function resolveNativeAntigravityReadinessContext(
  args: {
    runId: string
    generation: number
    runtimeEpoch: string
    worktreeId: string
    cwd: string
    home: string
    vaultPath: string
    settings: Pick<
      GlobalSettings,
      'agentCmdOverrides' | 'agentDefaultEnv' | 'agentDefaultArgs' | 'httpProxyUrl'
    >
    env?: NodeJS.ProcessEnv
  },
  binaryDigest = async (path: string): Promise<string> =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
): Promise<NativeAntigravityReadinessContext> {
  if (args.settings.httpProxyUrl?.trim()) {
    throw new AntigravityReadinessContextError('unsupported_proxy')
  }
  const inherited = args.env ?? process.env
  if (process.platform !== 'darwin') {
    throw new AntigravityReadinessContextError('unsupported_context')
  }
  if (
    args.settings.agentDefaultArgs?.antigravity?.trim() ||
    args.settings.agentCmdOverrides?.antigravity ||
    Object.keys(args.settings.agentDefaultEnv?.antigravity ?? {}).length
  ) {
    throw new AntigravityReadinessContextError('unsupported_launch_configuration')
  }
  if (
    Object.entries(inherited).some(
      ([key, value]) =>
        value &&
        /^(?:AGY_|GEMINI_|GOOGLE_|CLOUDCODE_|CLOUD_CODE_|ANTIGRAVITY_|SSH_CONNECTION$|SSH_CLIENT$|SSH_TTY$|WSL_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|http_proxy$|https_proxy$|all_proxy$|no_proxy$|SSL_CERT_|NODE_EXTRA_CA_CERTS$)/.test(
          key
        )
    )
  ) {
    throw new AntigravityReadinessContextError('unsupported_provider_environment')
  }
  const cwd = await realpath(args.cwd)
  const home = await realpath(args.home)
  const env: Record<string, string> = {
    HOME: home,
    PATH: [join(home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }
  const app = getAppEnvironment()
  const cli = prependOrcaCliDirToChildPath(env, {
    isPackaged: app.isPackaged(),
    userDataPath: app.getPath('userData'),
    resourcesPath: process.resourcesPath ?? null
  })
  if (!cli) {
    throw new AntigravityReadinessContextError('unsupported_cli_path')
  }
  env.ORCA_CLI_COMMAND = cli
  env.ORCA_USER_DATA_PATH = app.getPath('userData')
  const resolved = await resolveCommandOnLocalPath('agy', { env, cwd })
  const program = resolved ? await realpath(resolved) : null
  if (program) {
    const binary = await lstat(program)
    if (!binary.isFile() || binary.size > MAX_BINARY_BYTES) {
      throw new AntigravityReadinessContextError('unsupported_binary')
    }
  }
  if (!program) {
    throw new AntigravityReadinessContextError('missing_executable')
  }
  const binary = await binaryDigest(program)
  if (!AUDITED_BINARIES.has(binary)) {
    throw new AntigravityReadinessContextError('unsupported_binary')
  }
  const credential = await createAntigravityHostCredentialBackend(home).read()
  if (credential?.authMethod !== 'consumer' || !credential.identity) {
    throw new AntigravityReadinessContextError('missing_consumer_identity')
  }
  const vault = createEncryptedAntigravityAccountStore(args.vaultPath).read()
  const selected = vault.accounts.find((account) => account.id === vault.selectedAccountId)
  if (
    vault.selectedAccountId &&
    (!selected ||
      selected.subject !== credential.identity.subject ||
      selected.authMethod !== credential.authMethod)
  ) {
    throw new AntigravityReadinessContextError('selected_account_mismatch')
  }
  const configDigest = await antigravityConfigurationDigest(home, cwd)
  const plan = buildAgentStartupPlan({
    agent: 'antigravity',
    prompt: '',
    allowEmptyPromptLaunch: true,
    cmdOverrides: { antigravity: quoteStartupArg(program, 'posix') },
    platform: process.platform,
    agentArgs: '',
    agentEnv: env,
    sessionOptions: { model: ANTIGRAVITY_READINESS_MODEL },
    sessionOptionsOverrideAgentArgs: true
  })
  if (!plan) {
    throw new AntigravityReadinessContextError('startup_plan_unavailable')
  }
  const command = buildNativeAntigravityReadinessLaunchCommand(plan.launchCommand, env, cwd)
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        runId: args.runId,
        generation: args.generation,
        runtimeEpoch: args.runtimeEpoch,
        worktreeId: args.worktreeId,
        cwd,
        program,
        env,
        binary,
        credential: antigravityConsumerAuthorityDigest(credential),
        account: selected?.id ?? null,
        configDigest,
        settings: args.settings.agentDefaultArgs?.antigravity ?? null
      })
    )
    .digest('hex')
  return {
    runId: args.runId,
    generation: args.generation,
    fingerprint,
    program,
    cwd,
    env,
    command,
    launchConfig: plan.launchConfig
  }
}
