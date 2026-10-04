import { AGENT_HOOK_RUNTIME_ENV_KEYS } from '../ipc/pty/host-env/spawn-env-keys'
import {
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV
} from '../../shared/agent-hook-scrub-safe-env'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'

const PRESERVED_ENV = [
  ...AGENT_HOOK_RUNTIME_ENV_KEYS,
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKSPACE_ID',
  'ORCA_PROJECT_GROUP_ID',
  'ORCA_WORKSPACE_ROOT',
  'ORCA_ROOT_PATH',
  'ORCA_WORKTREE_PATH',
  'CONDUCTOR_ROOT_PATH',
  'GHOSTX_ROOT_PATH',
  'ORCA_CLI_COMMAND',
  'ORCA_USER_DATA_PATH',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION',
  'ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT'
] as const

// Bash builtins preserve Orca's inherited authority without putting it in process argv.
export function buildNativeAntigravityReadinessLaunchTransport(
  command: string,
  env: Readonly<Record<string, string>>,
  cwd?: string
): { program: string; args: string[] } {
  const script = [
    'while IFS= read -r orca_agy_export; do',
    'case "$orca_agy_export" in "declare -x "*) ;; *) exit 125 ;; esac',
    'orca_agy_env_name=${orca_agy_export#declare -x }; orca_agy_env_name=${orca_agy_env_name%%=*}',
    '[[ "$orca_agy_env_name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || exit 125',
    'done < <(export -p)',
    'unset orca_agy_export',
    'while IFS= read -r orca_agy_env_name; do',
    `case "$orca_agy_env_name" in ${PRESERVED_ENV.join('|')}) ;; *) unset "$orca_agy_env_name" || exit 125 ;; esac`,
    'done < <(compgen -e)',
    ...Object.entries(env).map(([name, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        throw new Error('Unsupported bound environment name')
      }
      return `export ${name}=${quoteStartupArg(value, 'posix')}`
    }),
    ...(cwd ? [`cd -- ${quoteStartupArg(cwd, 'posix')} || exit 125`] : []),
    `exec ${command}`
  ].join('\n')
  return { program: '/bin/bash', args: ['--noprofile', '--norc', '-p', '-c', script] }
}

export function buildNativeAntigravityReadinessLaunchCommand(
  command: string,
  env: Readonly<Record<string, string>>,
  cwd?: string
): string {
  const transport = buildNativeAntigravityReadinessLaunchTransport(command, env, cwd)
  return [transport.program, ...transport.args.map((arg) => quoteStartupArg(arg, 'posix'))].join(
    ' '
  )
}
