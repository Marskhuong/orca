import { AntigravityReadinessContextError } from '../antigravity/readiness-context-error'
import {
  resolveNativeAntigravityReadinessContext,
  type NativeAntigravityReadinessContext
} from '../antigravity/native-readiness-launch-context'
import { getAntigravityAccountVaultPath } from '../antigravity/native-account-host'
import { getAppEnvironment } from '../../shared/app-environment'
import type { RunRow } from './orchestration/types'
import type { OrchestrationDb } from './orchestration/db'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { agentStartedTelemetry } from '../agent-launch/agent-started-telemetry'
import { requireAntigravityRunReadiness } from './orchestration/run-capacity-state'

type BoundLaunchRuntime = {
  getOrchestrationDb(): OrchestrationDb
  resolveAntigravityReadinessContext(
    run: RunRow,
    worktree: string
  ): Promise<NativeAntigravityReadinessContext>
}

export async function resolveRuntimeAntigravityContext(args: {
  run: RunRow
  workspace: TerminalWorkspaceLaunchScope
  db: OrchestrationDb
  runtimeEpoch: string
  settings: ReturnType<RuntimeStore['getSettings']>
}) {
  const { run, workspace, db } = args
  if (workspace.connectionId || process.platform !== 'darwin') {
    throw new AntigravityReadinessContextError('unsupported_context')
  }
  const current = db.getRunRaw(run.id)
  if (
    !current ||
    current.consumer_generation !== run.consumer_generation ||
    current.home_database !== 'this_database'
  ) {
    throw new AntigravityReadinessContextError('identity_changed')
  }
  const context = await resolveNativeAntigravityReadinessContext({
    runId: run.id,
    generation: run.consumer_generation,
    runtimeEpoch: args.runtimeEpoch,
    worktreeId: workspace.id,
    cwd: workspace.path,
    home: getAppEnvironment().getPath('home'),
    vaultPath: getAntigravityAccountVaultPath(),
    settings: {
      ...args.settings,
      agentCmdOverrides: args.settings.agentCmdOverrides ?? {},
      agentDefaultArgs: args.settings.agentDefaultArgs ?? {},
      agentDefaultEnv: args.settings.agentDefaultEnv ?? {}
    }
  })
  if (db.getRunRaw(run.id)?.consumer_generation !== run.consumer_generation) {
    throw new AntigravityReadinessContextError('identity_changed')
  }
  return context
}

export async function validateBoundAntigravitySpawn(
  runtime: BoundLaunchRuntime,
  opts: TerminalCreateOptions,
  worktreeId: string
) {
  const bound = opts.antigravityReadinessLaunch
  if (!bound) {
    return
  }
  const run = runtime.getOrchestrationDb().getRunRaw(bound.runId)
  if (!run || run.consumer_generation !== bound.generation) {
    throw new AntigravityReadinessContextError('identity_changed')
  }
  const context = await runtime.resolveAntigravityReadinessContext(run, `id:${worktreeId}`)
  requireAntigravityRunReadiness(runtime.getOrchestrationDb(), run.id, context)
  if (context.fingerprint !== bound.fingerprint) {
    throw new AntigravityReadinessContextError('identity_changed')
  }
}

export async function resolveBoundAntigravityLaunch(
  runtime: BoundLaunchRuntime,
  opts: TerminalCreateOptions,
  workspace: TerminalWorkspaceLaunchScope,
  settings: ReturnType<RuntimeStore['getSettings']>
) {
  const bound = opts.antigravityReadinessLaunch
  if (
    !bound ||
    opts.startupAgent !== 'antigravity' ||
    workspace.connectionId ||
    process.platform !== 'darwin'
  ) {
    throw new AntigravityReadinessContextError('unsupported_context')
  }
  if (!isTuiAgentEnabled('antigravity', settings.disabledTuiAgents)) {
    throw new Error('Antigravity is disabled')
  }
  const run = runtime.getOrchestrationDb().getRunRaw(bound.runId)
  if (!run || run.consumer_generation !== bound.generation) {
    throw new AntigravityReadinessContextError('identity_changed')
  }
  const current = await runtime.resolveAntigravityReadinessContext(run, `id:${workspace.id}`)
  if (current.fingerprint !== bound.fingerprint) {
    throw new AntigravityReadinessContextError('identity_changed')
  }
  return {
    ...opts,
    command: bound.command,
    env: bound.env,
    cwd: bound.cwd,
    launchConfig: bound.launchConfig,
    launchAgent: 'antigravity' as const,
    telemetry: agentStartedTelemetry('antigravity', opts.launchSource)
  }
}
