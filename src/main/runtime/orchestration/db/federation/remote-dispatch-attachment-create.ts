import type { WorkerDispatchState, RemoteDispatchAttachmentRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { ensureMutationReceiptCapacity } from '../../mutation-receipt-capacity'
import type { OrchestrationDb } from '../orchestration-db'
import { federatedStubHomeRunId } from '../contract-constants'
import { insertRemoteDispatchAttachmentRow } from '../dispatch-row-writer'
import { recordRunCapacity, requireRunCapacity } from '../../run-capacity-state'
import { RunCapacityEvidence } from '../../../../../shared/orchestration-run-capacity'
import { runCapacityHandshakeRequiredRefusal } from '../../../../../shared/orchestration-dispatch-refusal-contract'

export function createRemoteDispatchAttachment(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    /** Absent from a v1.4.198 coordinator; replaced by a per-attachment stub Run. */
    runId?: string
    capacityEvidence?: RunCapacityEvidence
    taskId: string
    homePeerFingerprint: string
    protocolVersion: number
    runtimeEpoch: string
    /** Child depth computed by the Run home; absent from an old client = 1 (fails closed). */
    depth?: number
    mutationReceipt: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
  }
): RemoteDispatchAttachmentRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    if (params.homePeerFingerprint !== params.mutationReceipt.callerFingerprint) {
      throw new OrchestrationError(
        'resource_server_mismatch',
        'The authenticated Run-home peer does not match the attachment request.'
      )
    }
    const existingReceipt = this.getMutationReceipt(
      params.mutationReceipt.callerFingerprint,
      params.mutationReceipt.requestId
    )
    if (existingReceipt) {
      throw new OrchestrationError(
        existingReceipt.method === params.mutationReceipt.method &&
          existingReceipt.payload_hash === params.mutationReceipt.payloadHash
          ? 'operation_unknown'
          : 'request_mismatch',
        `Remote attachment request ${params.mutationReceipt.requestId} already exists.`
      )
    }
    const runId = params.runId ?? federatedStubHomeRunId(params.dispatchId)
    if (!params.capacityEvidence || !params.runId) {
      const refusal = runCapacityHandshakeRequiredRefusal(runId)
      throw new OrchestrationError(refusal.code, refusal.message, refusal.data)
    }
    RunCapacityEvidence.parse(params.capacityEvidence)
    if (!runId.trim()) {
      throw new OrchestrationError('invalid_argument', 'Missing Run ID')
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runs (id, objective, home_database, consumer_generation, legacy)
         VALUES (?, ?, 'remote', 0, 0)`
      )
      .run(runId, `Coordinated from ${params.homePeerFingerprint}`)
    this.requireRun(runId)
    if (this.getRunRaw(runId)?.home_database === 'this_database') {
      const homeDispatch = this.getDispatchContextById(params.dispatchId)
      if (homeDispatch?.run_id !== runId || homeDispatch.task_id !== params.taskId) {
        throw new OrchestrationError(
          'resource_server_mismatch',
          'Local Run attachment must match its home Dispatch.'
        )
      }
      // A loopback attachment uses the local authority without overwriting it with peer evidence.
      requireRunCapacity(this, runId)
    } else {
      recordRunCapacity(this, runId, params.capacityEvidence, params.homePeerFingerprint)
    }
    ensureMutationReceiptCapacity(this.db)
    this.db
      .prepare(
        `INSERT INTO mutation_receipts (
           caller_fingerprint, request_id, method, payload_hash, state, receipt
         ) VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        params.mutationReceipt.callerFingerprint,
        params.mutationReceipt.requestId,
        params.mutationReceipt.method,
        params.mutationReceipt.payloadHash,
        JSON.stringify({ accepted: { dispatchId: params.dispatchId } })
      )
    insertRemoteDispatchAttachmentRow(this.db, {
      dispatchId: params.dispatchId,
      runId,
      taskId: params.taskId,
      homePeerFingerprint: params.homePeerFingerprint,
      protocolVersion: params.protocolVersion,
      runtimeEpoch: params.runtimeEpoch,
      depth: params.depth ?? 1
    })
    this.db.exec('COMMIT')
    return this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getRemoteDispatchAttachment(
  this: OrchestrationDb,
  dispatchId: string
): RemoteDispatchAttachmentRow | undefined {
  return this.db
    .prepare('SELECT * FROM remote_dispatch_attachments WHERE dispatch_id = ?')
    .get(dispatchId) as RemoteDispatchAttachmentRow | undefined
}

export function recordRemoteAttachmentStage(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    stage: string
    state?: WorkerDispatchState
    worktreeId?: string
    terminalHandle?: string
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
    lastError?: string
  }
): RemoteDispatchAttachmentRow {
  const current = this.getRemoteDispatchAttachment(params.dispatchId)
  if (!current) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Remote Dispatch ${params.dispatchId} was not found.`
    )
  }
  this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET stage = ?, state = ?, worktree_id = ?, terminal_handle = ?, setup_state = ?,
           effects = ?, residual_resources = ?, last_error = ?, updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(
      params.stage,
      params.state ?? current.state,
      params.worktreeId ?? current.worktree_id,
      params.terminalHandle ?? current.terminal_handle,
      params.setupState ?? current.setup_state,
      params.effects ? JSON.stringify(params.effects) : current.effects,
      params.residualResources
        ? JSON.stringify(params.residualResources)
        : current.residual_resources,
      params.lastError ?? current.last_error,
      params.dispatchId
    )
  return this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow
}

export function updateRemoteAttachmentSetupEvidence(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    setupState: string
    effects: unknown[]
  }
): { attachment: RemoteDispatchAttachmentRow; changed: boolean } {
  const current = this.getRemoteDispatchAttachment(params.dispatchId)
  if (!current) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Remote Dispatch ${params.dispatchId} was not found.`
    )
  }
  const effects = JSON.stringify(params.effects)
  if (current.setup_state === params.setupState && current.effects === effects) {
    return { attachment: current, changed: false }
  }
  this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET setup_state = ?, effects = ?, updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(params.setupState, effects, params.dispatchId)
  return {
    attachment: this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow,
    changed: true
  }
}

export type RemoteDispatchAttachmentCreateMethods = {
  createRemoteDispatchAttachment: typeof createRemoteDispatchAttachment
  getRemoteDispatchAttachment: typeof getRemoteDispatchAttachment
  recordRemoteAttachmentStage: typeof recordRemoteAttachmentStage
  updateRemoteAttachmentSetupEvidence: typeof updateRemoteAttachmentSetupEvidence
}

export function attachRemoteDispatchAttachmentCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRemoteDispatchAttachment,
    getRemoteDispatchAttachment,
    recordRemoteAttachmentStage,
    updateRemoteAttachmentSetupEvidence
  })
}
