/**
 * The admission of a turn to a thread (COR-1580, COR-1588): at most one run is live on a thread, and
 * deciding that and creating the run that makes it so are one decision, taken under the thread's
 * durable lease (`ag-ui-lease.ts`).
 *
 * The AG-UI mount starts a chat's turn through this module, and so does {@link startIdleTurn}, which
 * a door other than Chat uses (Interborough's `POST /api/chats/{chat}/messages`). Both contend for
 * the same lease record and decide busyness with the same {@link ThreadAdmission.threadBusy}, so a
 * message sent from either door waits its turn for a run the other started. `tasks.start` has no
 * fence of its own per session: a caller that skipped this would start a second run on the session
 * and overwrite its `lastRunId`, which busy checks, resume and Stop read.
 *
 * @module ag-ui-thread-admission
 */
import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { AgentSession } from '@lostgradient/operative';

import { BureauError } from '../bureau-errors.ts';
import { isDurableRunUnsettled } from '../durable-run-waits.ts';
import type { Bureau } from '../bureau-types/facade.ts';
import {
  type AgUiLease,
  type AgUiLeases,
  createAgUiLeases,
  releaseQuietly,
} from './ag-ui-lease.ts';

/** What thread admission reads from the Bureau. */
export type ThreadAdmissionBureau = {
  readonly tasks: Pick<Bureau['tasks'], 'workflow'>;
  readonly internals: Pick<Bureau['internals'], 'kv'>;
};

/** The deciding half of admission: the thread's leases and the rule that says whether it is busy. */
export type ThreadAdmission = {
  /** The leases admission is taken under, in the Bureau's own store. */
  readonly leases: AgUiLeases;
  /**
   * Whether the thread has an unsettled run, decided from durable state alone, so it is the same
   * answer in every process and in every state. Process-local state (the runs and reviews this
   * process holds) may choose what an attach streams, but it never decides this: a start in
   * another process cannot see it.
   *
   * The thread is busy when the session's last run is unsettled:
   *
   * - live, starting, or parked on a human wait: the session says `running` and the durable run is
   *   in Bureau's own non-terminal set (pending, running, suspended; `pending` is a run whose
   *   inline launch has not flushed yet). A marker whose durable run has settled, as a crash can
   *   leave, is not busy; a read that fails is, because a start admitted on a guess forks the
   *   thread;
   * - settled with an unresolved approval: the session still holds a `pendingApprovalOverrides`
   *   entry for that run. Bureau persists the entry when an approval is gated and removes it in
   *   the same write as the resolution, whichever process resolves it and however; an entry whose
   *   binding has expired is not pending, by the rule `reviews.list` uses.
   */
  readonly threadBusy: (session: AgentSession | undefined) => Promise<boolean>;
  /**
   * Starts a turn under a lease already held on the thread, when the thread is idle: re-decides
   * busyness from `session` (read under that lease), confirms the lease was not taken over, then
   * calls `start`. Resolves `{ admitted: false }` without calling `start` when the thread is busy
   * or the lease is gone. An error from `start` propagates.
   */
  admit<T>(
    lease: AgUiLease,
    session: AgentSession | undefined,
    start: () => Promise<T>,
  ): Promise<{ readonly admitted: true; readonly value: T } | { readonly admitted: false }>;
};

/**
 * Whether a session holds an unexpired tool approval for `runId` in `pendingApprovalOverrides`.
 * Bureau persists the entry when an approval is gated and removes it in the same write as the
 * resolution; an entry whose binding has expired is not pending, by the rule `reviews.list`
 * uses.
 */
export function holdsPendingApproval(
  metadata: AgentSession['metadata'],
  runId: string,
  asOf: number,
): boolean {
  const overrides = metadata['pendingApprovalOverrides'];
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return false;
  }
  return Object.entries(overrides).some(([reviewId, approval]) => {
    if (!reviewId.startsWith(`approval:${runId}:`)) return false;
    const expiresAt = (approval as { approvalBinding?: { expiresAt?: unknown } } | null)
      ?.approvalBinding?.expiresAt;
    return typeof expiresAt !== 'number' || expiresAt > asOf;
  });
}

/** Builds the admission over a Bureau's store, on `runtime`'s clock. */
export function createThreadAdmission(options: {
  readonly bureau: ThreadAdmissionBureau;
  readonly runtime: Pick<RuntimeServices, 'clock' | 'timers' | 'identifiers'>;
  readonly leaseMs?: number | undefined;
}): ThreadAdmission {
  const { bureau, runtime } = options;
  const leases = createAgUiLeases({
    kv: bureau.internals.kv!,
    runtime,
    leaseMs: options.leaseMs,
  });

  async function threadBusy(session: AgentSession | undefined): Promise<boolean> {
    try {
      const metadata = session?.metadata;
      const lastRunId = metadata?.['lastRunId'];
      if (metadata === undefined || typeof lastRunId !== 'string') return false;
      if (metadata['lastRunStatus'] === 'running') {
        const durable = await bureau.tasks.workflow(lastRunId);
        if (durable !== undefined && durable !== null && isDurableRunUnsettled(durable.status)) {
          return true;
        }
      }
      // `expiresAt` was issued by Armorer's clock, read here with the admission's: the same
      // clock assumption the thread lease makes across processes (skew below the lease
      // length minus its renewal interval). A fast clock here admits a start a slow
      // holder could still approve.
      return holdsPendingApproval(metadata, lastRunId, runtime.clock.now());
    } catch {
      return true;
    }
  }

  return {
    leases,
    threadBusy,
    async admit(lease, session, start) {
      if (await threadBusy(session)) return { admitted: false };
      // A lease this start no longer holds was taken over: another start may have
      // decided the thread is idle too.
      if (!(await lease.renew())) return { admitted: false };
      return { admitted: true, value: await start() };
    },
  };
}

/**
 * Starts the turn that answers `input` on the chat `threadId`, when no run is live on it, and
 * refuses with `CONFLICT` (a {@link BureauError}) when one is, so a message sent through a door
 * other than Chat waits its turn like one sent from Chat. The turn is the thread's agent's, as the
 * session read under the lease names it; a thread with no session is `NOT_FOUND`. It does not
 * queue the message into the live run (`contexts.input` does that); the caller sends it again.
 */
export async function startIdleTurn(
  bureau: ThreadAdmissionBureau &
    Pick<Bureau, 'runtimeServices'> & {
      readonly contexts: Pick<Bureau['contexts'], 'get'>;
      readonly tasks: Pick<Bureau['tasks'], 'start' | 'workflow'>;
    },
  options: { readonly threadId: string; readonly input: string; readonly principal: string },
): Promise<{ readonly id: string }> {
  const busy = (): BureauError =>
    new BureauError(`Chat "${options.threadId}" has a run in progress.`, 'CONFLICT');
  const admission = createThreadAdmission({ bureau, runtime: bureau.runtimeServices });
  const lease = await admission.leases.acquire('thread', options.threadId);
  if (lease === undefined) throw busy();
  try {
    // Read again under the lease: the decision below is made from this record. A read that
    // fails is a thread that is busy, because a start admitted on a guess forks the thread.
    let session: AgentSession | undefined;
    try {
      session = await bureau.contexts.get(options.threadId);
    } catch {
      throw busy();
    }
    if (session === undefined) {
      throw new BureauError(`No chat has the identifier "${options.threadId}".`, 'NOT_FOUND');
    }
    const agentName = session.agentName;
    const admitted = await admission.admit(lease, session, () =>
      bureau.tasks.start(agentName, options.input, {
        contextId: options.threadId,
        principal: options.principal,
      }),
    );
    if (!admitted.admitted) throw busy();
    return admitted.value;
  } finally {
    await releaseQuietly(lease);
  }
}
