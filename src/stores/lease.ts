export function createMonotonicLeaseIdSource() {
  let lastLeaseId = 0
  return () => ++lastLeaseId
}

export function isCurrentLease(currentLeaseId: number | null, leaseId: number) {
  return currentLeaseId === leaseId
}
