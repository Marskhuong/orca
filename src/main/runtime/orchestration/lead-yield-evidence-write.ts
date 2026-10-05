import type Database from '../../sqlite/sync-database'

// Evidence failures must not roll back or interrupt the caller's lifecycle operation.
export function writeLeadYieldEvidence(db: Database.Database, write: () => void): boolean {
  let opened = false
  try {
    db.exec('SAVEPOINT lead_yield_evidence')
    opened = true
    write()
    db.exec('RELEASE lead_yield_evidence')
    return true
  } catch {
    if (opened) {
      try {
        db.exec('ROLLBACK TO lead_yield_evidence')
        db.exec('RELEASE lead_yield_evidence')
      } catch {
        console.warn('Yield Guard evidence rollback unavailable.')
      }
    }
    console.warn('Yield Guard evidence unavailable; lifecycle execution continues.')
    return false
  }
}

export function clearSettledLeadYieldExpectation(db: Database.Database, dispatchId: string): void {
  writeLeadYieldEvidence(db, () => {
    db.prepare(`UPDATE lead_yield_expectations SET lead_yield_expected = 0, cleared_by = 'settled'
      WHERE dispatch_id = ? AND lead_yield_expected = 1`).run(dispatchId)
  })
}
