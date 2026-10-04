import type { OrcaRuntimeService } from '../orca-runtime'

export function orchestrationTerminalSummary(
  handle: string
): Awaited<ReturnType<OrcaRuntimeService['showTerminal']>> {
  return {
    handle,
    ptyId: null,
    worktreeId: 'repo::worktree',
    worktreePath: '/fixture',
    branch: 'fixture',
    tabId: 'fixture-tab',
    leafId: 'fixture-leaf',
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    agentIdentity: 'codex',
    paneRuntimeId: 1,
    rendererGraphEpoch: 1
  }
}
