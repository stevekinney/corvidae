/**
 * Process ownership for repository tooling and the Interborough supervisor: the identity of a
 * process (its pid and the start time `ps` reports), the owner records and reclaim guards that
 * lock directories carry, and the owned process lease and process group built on them.
 *
 * Scheduling policy (the host lock's queue, test slots, memory admission, Turborepo defaults) is
 * not here; it stays in the repository's root `scripts/`, which consume this library.
 *
 * @module
 */
export {
  describeHolder,
  errorCode,
  isAbsentOrPartial,
  ownerFileName,
  readOwner,
  readTicket,
  recordProcessGroup,
  removeLock,
  statIfPresent,
  type HeldHostLock,
  type HostLockHolder,
  type OwnerRecord,
} from './lock-records.ts';
export {
  OwnedProcessGroupUnverifiedError,
  runOwnedProcessGroup,
  type OwnedProcessGroupOptions,
} from './owned-process-group.ts';
export {
  acquireOwnedProcessLease,
  retireOwnedProcessLease,
  verifiedGate,
} from './owned-process-lease.ts';
export {
  isProcessAlive,
  isProcessGroupAlive,
  isSameProcess,
  processStartTime,
  processTableEnvironment,
} from './process-identity.ts';
export {
  judgeByProcess,
  reclaimAbandonedAs,
  reclaimGuardFor,
  takeReclaimGuard,
  tokenlessGuardStaleMs,
  type LivenessJudge,
  type Reclaimer,
} from './reclaim.ts';
