/**
 * Session input admission (COR-2376 slice S6): signal a session, submit and retract a session input,
 * deliver a human-wait decision, and forget the grants of a deleted session. Built by
 * `constructBureau` and reached only through `createBureau`; the contexts facade and the review
 * resolution call into it.
 */
import type { AgentDefinitions } from '../agent-catalog';
import {
  type AgentSession,
  type SessionInputAdmissionOutcome,
  type SessionInputAdmissionRequest,
  type SessionInputRetractionOutcome,
  type SessionInputRetractionRequest,
  type SessionStore,
  parseSessionInputPayload,
  snapshotPayload,
} from '@lostgradient/operative';
import type { BureauCore, SteeringCursor } from './core';
import { BureauError, BureauShuttingDownError, toBadRequest } from '../bureau-errors';
import { CURRENT_SCHEMA_VERSION } from 'conversationalist';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import type { Mailbox } from '@lostgradient/weft';
import {
  type PersistedSessionInput,
  SESSION_INPUT_RETRACTED_REASON,
  SESSION_INPUT_RETRACT_SETTLE_MILLISECONDS,
  type SessionInputAdmissionAttemptOutcome,
  SessionInputMailboxPurgedError,
  admitSessionInput,
  readSessionInputReceipt,
} from '../session-input-durability';
import { SESSION_INPUT_RUN_ENDED_REASON } from '../session-input-settlement';
import type { SessionPendingReview } from '../types';
import { humanWaitDeliveryId } from '../run-human-waits';
import { serializeUnknownError } from '../serialization';
import { withoutGrantsFor } from '../session-grants';

/** The callables session input admission reads from elsewhere in `constructBureau`. */
export interface SessionInputAdmissionPeers {
  /** Whether this Bureau no longer admits session input. */
  readonly isSessionInputClosed: () => boolean;
  /** The mailbox of a session incarnation, if its id is addressable. */
  readonly tryGetSessionInputMailbox: (
    sessionId: string,
    incarnation: string,
  ) => Mailbox | undefined;
  /** Every live run id of a session incarnation, in this process and in the durable log. */
  readonly liveSessionRunIdsEverywhere: (
    sessionId: string,
    incarnation: string,
    namedRunId?: string,
  ) => Promise<string[]>;
  /** Resolves the live run a session input addresses before it is admitted. */
  readonly resolveLiveSessionPreAdmission: (
    sessionId: string,
    session: AgentSession,
    principal: string,
    namedRunId?: string,
    idleAllowed?: boolean,
  ) => Promise<{
    verdict: 'not-found' | 'session-terminal' | 'proceed';
    liveRunIds: string[];
  }>;
  /** Folds the durable steering log of a session into its cursor. */
  readonly catchUpSteering: (
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
  ) => Promise<SteeringCursor>;
  /** `runtime.kv`, when this Bureau keeps durable steering. */
  readonly durableSteeringStore: () => ConditionalTextValueStore | undefined;
  /** Runs an operation after every earlier steering log operation for the session. */
  readonly enqueueSteering: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  /** The configured session store; throws when there is none. */
  readonly requireSessionStore: () => SessionStore;
}

/** Builds the session input admission of one Bureau. Synchronous, and registers nothing. */
export function createSessionInputAdmission<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SessionInputAdmissionPeers,
) {
  const {
    runtimeServices,
    runtime,
    diagnose,
    sessionInputSessionBacklogLimit,
    sessionInputPrincipalBacklogLimit,
    inFlightSessionInputAdmissions,
    runRequestContexts,
    isTransportIssuedAuthority,
    inFlightSessionDeletions,
  } = core;

  /**
   * Look up the current durable run id for a session. Used by signal/update/query
   * to route the operation to the correct workflow handle.
   *
   * Requires that `lastRunStatus` is `'running'`: completed, aborted, and error
   * sessions retain their `lastRunId` but targeting a terminal workflow with a
   * signal/update would silently mis-route or surface a low-level engine error
   * instead of the expected "no active run" response.
   */
  async function requireSessionRunId(sessionId: string): Promise<string> {
    const session = await peers.requireSessionStore().load(sessionId);
    if (!session || inFlightSessionDeletions.has(sessionId)) {
      throw new BureauError(`Session not found: ${sessionId}`, 'NOT_FOUND');
    }
    const runId = session.metadata['lastRunId'];
    if (typeof runId !== 'string' || !runId) {
      throw new BureauError(`Session ${sessionId} has no active run`, 'NOT_FOUND');
    }
    const runStatus = session.metadata['lastRunStatus'];
    if (runStatus !== 'running') {
      throw new BureauError(`Session ${sessionId} has no active run`, 'NOT_FOUND');
    }
    return runId;
  }

  /**
   * COR-1579 — the delivery id the next `signalSession` call delivers under, set only by
   * {@link deliverHumanWaitDecision} for the synchronous start of that call. `resolveReview`
   * delivers a human-wait decision through the public `bureau.contexts.signal` (one seam, which a
   * host or test can observe), whose signature has no delivery id; the call reads and clears this
   * before its first `await`, so no other call can see it. A wrapper around `bureau.contexts.signal`
   * must therefore call through before it awaits anything, or the delivery goes out unkeyed.
   */
  let keyedSessionDelivery: string | undefined;

  /**
   * Deliver a human-wait decision on a session run keyed by its review id, so a retry or a
   * same-decision resolver in another process delivers it once (Weft deduplicates a keyed signal
   * by its accepted-response marker), and nothing is left buffered for the run's next park.
   */
  function deliverHumanWaitDecision(
    review: Extract<SessionPendingReview, { kind: 'human-wait' }>,
    payload: unknown,
  ): Promise<void> {
    keyedSessionDelivery = humanWaitDeliveryId(review.id);
    try {
      return core.bureau.contexts.signal(review.sessionId, review.signalName, payload);
    } finally {
      keyedSessionDelivery = undefined;
    }
  }

  async function signalSession(sessionId: string, name: string, payload?: unknown): Promise<void> {
    const signalId = keyedSessionDelivery;
    keyedSessionDelivery = undefined;
    if (!runtime.durable)
      throw new BureauError('Durable engine not configured', 'NOT_CONFIGURED', 'durable');
    const runId = await requireSessionRunId(sessionId);
    const requestContext = runRequestContexts.get(runId);
    if (
      requestContext &&
      isTransportIssuedAuthority(requestContext) &&
      (!core.requestAuthorityValidator || !(await core.requestAuthorityValidator(requestContext)))
    ) {
      throw new BureauError(
        'Cannot signal: the request authority is no longer current.',
        'CONFLICT',
      );
    }
    await (signalId === undefined
      ? runtime.durable.engine.signal(runId, name, payload)
      : runtime.durable.engine.signal(runId, name, payload, { signalId }));
    // AB-13 — a signal is how a human-wait park is released (directly, or via
    // `resolveReview`'s human-wait approve path). Reacquire the concurrency
    // slot `HumanWaitParkedEvent` freed. A no-op when this runId was never
    // parked (e.g. a signal delivered to a run that never called
    // `requestHumanInput`) or when no flow control is configured.
    core.flowController?.markResumed(runId);
  }

  /**
   * AB-42/AB-194 — admit a caller's session input. Pre-admission checks run
   * in AB-42's fixed order: authorization (`not-found`) first, then session
   * lifecycle (`session-terminal`), then capability/capacity
   * (`unsupported-capability`) — reversing the first two would let an
   * unauthorized caller learn a session exists.
   *
   * COR-435/COR-1476: on a durably-configured bureau an authorized request to
   * a non-terminal session is admitted to the session's mailbox (`admitted`,
   * `replayed`, `conflict`, or `backlog-exhausted`). An admitted input ends
   * `promoted` once a live run's step boundary appends its user turn (at most
   * once, in admission order within a run, keyed by the mailbox command, under
   * the input's own id, and promoted in the write that saves the turn), or
   * `canceled` when its run ends first, so the client resends it. Bureau never
   * starts a run to answer input: after the admission commits this method
   * reads the session's liveness, and with no run live or starting it cancels
   * the input itself and returns the re-read receipt (see
   * `session-input-settlement.ts`). `steer` and `queue` share that one FIFO
   * path. A bureau with no durable mailbox, or a session id too long to
   * address one, answers `unsupported-capability`.
   */
  function assertSessionInputAdmissionOpen(): void {
    if (core.runAdmissionClosed) {
      throw new BureauError('Cannot submit session input: Bureau is shutting down.', 'CONFLICT');
    }
  }

  async function submitSessionInput(
    sessionId: string,
    callerRequest: SessionInputAdmissionRequest,
  ): Promise<SessionInputAdmissionOutcome> {
    // Unlike signalSession, this does NOT throw
    // BureauError('NOT_CONFIGURED') when no session store is composed: an
    // ephemeral bureau (no persistence/storage) is a supported configuration,
    // and every sessionId is necessarily unknown in it — the correct outcome
    // per this method's own contract is `not-found`, not a throw.
    // A durable admission reads the engine and the log from its first await to
    // its last, so shutdown waits for the whole of it before it disposes
    // either; once shutdown starts, none begins, as for steering.
    assertSessionInputAdmissionOpen();
    // COR-716: a payload no run could read is refused here, at the contract's own door,
    // rather than admitted and then rejected without retry when a step boundary decodes it.
    try {
      parseSessionInputPayload(callerRequest.payload);
    } catch (error) {
      toBadRequest(
        `"payload" is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // COR-1661: `expiresAt` bounds how long the input may wait, so it must be an instant.
    if (
      callerRequest.expiresAt !== undefined &&
      Number.isNaN(Date.parse(callerRequest.expiresAt))
    ) {
      toBadRequest('"expiresAt" must be an ISO 8601 timestamp');
    }
    // The caller owns its payload and may edit it as soon as this call yields, but the
    // admission awaits the session, its liveness, and the mailbox before it persists.
    // Copy what was validated, now, and admit the copy.
    const request: SessionInputAdmissionRequest = {
      ...callerRequest,
      payload: snapshotPayload(callerRequest.payload),
    };
    const sessionStoreForInput = runtime.sessionStore;
    const session = sessionStoreForInput ? await sessionStoreForInput.load(sessionId) : undefined;
    // `session` truthy implies `sessionStoreForInput` was truthy above, but
    // TypeScript cannot carry that narrowing across the ternary into later
    // code — this makes it explicit rather than asserting it away.
    if (!session || !sessionStoreForInput) {
      return { outcome: 'not-found' };
    }
    // COR-1481: input to a context being deleted reads as input to one that is gone.
    if (inFlightSessionDeletions.has(sessionId)) return { outcome: 'not-found' };
    // COR-1661: input checked against an earlier incarnation of the context is input to a session
    // that is not there, whatever now answers to its id.
    if (request.incarnation !== undefined && request.incarnation !== session.incarnation) {
      return { outcome: 'not-found' };
    }
    // COR-301/COR-1569: the same live-run-aware checks steering makes,
    // across every process sharing this backend. A request carries no run
    // id, so authorization targets the session's sole live run.
    const preAdmission = await peers.resolveLiveSessionPreAdmission(
      sessionId,
      session,
      request.principal,
    );
    if (preAdmission.verdict === 'not-found') return { outcome: 'not-found' };
    if (preAdmission.verdict === 'session-terminal') {
      return { outcome: 'session-terminal', sessionId };
    }

    // `tryGet...`, not `get...`: a session id Weft cannot address as a mailbox
    // resource (over 256 bytes) is a deployment limit, so it answers
    // `unsupported-capability` like a bureau with no mailbox rather than throwing.
    const sessionMailbox = peers.tryGetSessionInputMailbox(sessionId, session.incarnation);
    const storage = runtime.durableStorage;
    const kv = runtime.kv;
    if (sessionMailbox === undefined || storage === undefined || kv === undefined) {
      return { outcome: 'unsupported-capability', reason: 'durable-mailbox-unavailable' };
    }
    // A mailbox exists only with the durable engine (`getSessionInputMailbox`),
    // and the engine with `kv` is what composes the settlement, so it is never
    // absent here; this only narrows the type, and fails loudly if the
    // composition above ever changes.
    const sessionInputSettlement = core.sessionInputSettlement;
    if (sessionInputSettlement === undefined) {
      throw new Error('Session-input admission reached a bureau without its settlement.');
    }

    const id = request.id ?? runtimeServices.identifiers.next('session-input');
    const reservationKey = `${request.principal}\u0000session-input\u0000${id}`;

    const payload: PersistedSessionInput = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      incarnation: session.incarnation,
      payload: request.payload,
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      ...(request.supersedes !== undefined ? { supersedes: request.supersedes } : {}),
    };

    // ORDERING (see `session-input-settlement.ts`): the session's marker is
    // written BEFORE the admission, so admitted input is never missing from the
    // sweep's index; the admission commits BEFORE liveness is read below, and the
    // ending run reads the mailbox only after its own not-live write, so one side
    // always sees the other. A failure writing the marker refuses the admission.
    // Checked again after the awaits above: a shutdown that started during them
    // must not find a new admission outside its drain.
    assertSessionInputAdmissionOpen();
    // One admission of a `(principal, id)` at a time in this process, each
    // answered on its own: a concurrent submission with another payload reads
    // the mailbox's `conflict`, and one for another session reads the
    // identity's. Nothing is coalesced into another call's receipt.
    const previous = inFlightSessionInputAdmissions.get(reservationKey);
    const runAdmission = (): Promise<SessionInputAdmissionAttemptOutcome> =>
      (async () => {
        await sessionInputSettlement.markOpen(sessionId, session.incarnation);
        return admitSessionInput({
          storage,
          kv,
          sessionMailbox,
          sessionId,
          incarnation: session.incarnation,
          id,
          principal: request.principal,
          deliveryMode: request.deliveryMode,
          payload,
          principalBacklogLimit: sessionInputPrincipalBacklogLimit(),
          sessionBacklogLimitForCrossSessionRead: sessionInputSessionBacklogLimit(),
          nowMs: runtimeServices.clock.now(),
        }).catch((error: unknown): SessionInputAdmissionAttemptOutcome => {
          // COR-1934: the chat was deleted and its mailbox purged while this admission was in
          // flight; it is refused as any input to a chat that is gone.
          if (error instanceof SessionInputMailboxPurgedError) return { outcome: 'not-found' };
          throw error;
        });
      })();
    const admission = (
      previous === undefined ? runAdmission() : previous.then(runAdmission, runAdmission)
    )
      .then(async (outcome): Promise<SessionInputAdmissionOutcome> => {
        if (outcome.outcome !== 'admitted') return outcome;
        const { receipt, commandId } = outcome;
        const admitted: SessionInputAdmissionOutcome = { outcome: 'admitted', receipt };
        if (sessionInputSettlement === undefined) return admitted;
        // The marker written before the admission can be removed in between by
        // a sweep that read it, found the mailbox still empty, and deleted it
        // after the admission committed. Bumping it again now, with the input
        // durable, keeps the session listed whatever happened to the first bump.
        try {
          await sessionInputSettlement.markOpen(sessionId, session.incarnation);
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] Could not re-mark session "${sessionId}" as having open input after admitting "${id}": ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // Shutdown releases open input rather than cancelling it; the next
        // boot's recovered run delivers it, or the sweep cancels it.
        if (peers.isSessionInputClosed()) return admitted;
        // COR-1476 — the admission above is committed. Only now is liveness
        // read, after catching up the steering log, so a run whose `run-ended`
        // entry another process wrote is not counted live. No run live or
        // starting means nothing will ever deliver the input, so it is
        // cancelled here and the caller reads `canceled`. A liveness read that
        // fails is answered the same way: an input admitted on a guess would
        // be left open.
        let live: readonly string[];
        try {
          const steeringKv = peers.durableSteeringStore();
          if (steeringKv !== undefined) {
            await peers.enqueueSteering(sessionId, () =>
              peers.catchUpSteering(steeringKv, sessionId, session.incarnation),
            );
          }
          live = await peers.liveSessionRunIdsEverywhere(sessionId, session.incarnation);
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] Could not read the live runs of session "${sessionId}" after admitting input "${id}"; the input is cancelled rather than left open: ${serializeUnknownError(error)}`,
            cause: error,
          });
          live = [];
        }
        if (live.length > 0) return admitted;
        try {
          await sessionMailbox.requestCancellation({
            commandId,
            reason: SESSION_INPUT_RUN_ENDED_REASON,
          });
          return {
            outcome: 'admitted',
            receipt: await readSessionInputReceipt(kv, sessionMailbox, sessionId, commandId),
          };
        } catch (error) {
          // Still open, and the marker written above lists it for the sweep.
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] Could not cancel input "${id}" of session "${sessionId}", which no run is live to deliver: ${serializeUnknownError(error)}`,
            cause: error,
          });
          return admitted;
        }
      })
      .finally(() => {
        if (inFlightSessionInputAdmissions.get(reservationKey) === admission) {
          inFlightSessionInputAdmissions.delete(reservationKey);
        }
      });
    inFlightSessionInputAdmissions.set(reservationKey, admission);
    return admission;
  }

  /**
   * B06 (row 18k) — takes back one input its own principal admitted and no run has taken yet: a
   * follow-up the person removes before the run reaches it. The command is cancelled in the
   * session's mailbox, so no step boundary can claim it, and the answer says whether that landed
   * in time. A command a run already claimed is the run's: the gate keeps its lease, the step
   * appends the turn, and the cancellation only closes the command once the turn commits, so that
   * case is answered `delivered`, as is an input already promoted. Another principal's input, an
   * unknown id, and an unknown session or incarnation all answer `not-found`.
   */
  async function retractSessionInput(
    sessionId: string,
    request: SessionInputRetractionRequest,
  ): Promise<SessionInputRetractionOutcome> {
    assertSessionInputAdmissionOpen();
    const session = runtime.sessionStore ? await runtime.sessionStore.load(sessionId) : undefined;
    if (session === undefined) return { outcome: 'not-found' };
    if (request.incarnation !== undefined && request.incarnation !== session.incarnation) {
      return { outcome: 'not-found' };
    }
    const sessionMailbox = peers.tryGetSessionInputMailbox(sessionId, session.incarnation);
    const kv = runtime.kv;
    if (sessionMailbox === undefined || kv === undefined) {
      return { outcome: 'unsupported-capability', reason: 'durable-mailbox-unavailable' };
    }
    const admitted = await sessionMailbox.receiptByIdempotencyKey(request.id);
    // An id is unique within its session whatever its principal, so another caller's input is
    // answered as one that is not there.
    if (admitted === null || admitted.caller !== request.principal) {
      return { outcome: 'not-found' };
    }
    const { commandId } = admitted;
    const before = await readSessionInputReceipt(kv, sessionMailbox, sessionId, commandId);
    if (before.state === 'promoted') return { outcome: 'delivered', receipt: before };
    const cancellation = await sessionMailbox.requestCancellation({
      commandId,
      reason: SESSION_INPUT_RETRACTED_REASON,
    });
    // `requested` is a command a step boundary holds. The boundary honors a cancellation that
    // landed before its last check by rejecting the command, so it is never appended; one that
    // landed after is closed once the turn commits, and the run has the input. The wait lets the
    // boundary settle the first kind, and the receipt, never the wait, says which it was: a turn
    // that appended the input is `promoted`, one the boundary rejected has ended undelivered, and a
    // command still open when the wait runs out is held by a step that is appending it.
    if (cancellation.status === 'requested') {
      await sessionMailbox
        .awaitCleanup({
          commandId,
          timeoutMs: SESSION_INPUT_RETRACT_SETTLE_MILLISECONDS,
          pollIntervalMs: 10,
        })
        .catch(() => undefined);
    }
    const receipt = await readSessionInputReceipt(kv, sessionMailbox, sessionId, commandId);
    const endedUndelivered =
      receipt.state === 'canceled' || receipt.state === 'failed' || receipt.state === 'expired';
    const heldByStep = cancellation.status === 'requested' && !endedUndelivered;
    return receipt.state === 'promoted' || heldByStep
      ? { outcome: 'delivered', receipt }
      : { outcome: 'retracted', receipt };
  }

  /**
   * B06 (row 20c) — forget the chat's "Allow for the rest of this chat" grants of `tools`, so Retry
   * on a reply that failed sends the turn again with the interrupted tool back behind its approval.
   * Only the session's metadata changes: every row of the conversation stays, and the failed
   * attempt is kept on record. Like a rename it is not activity, so `updatedAt` does not move.
   */
  async function forgetSessionGrants(
    id: string,
    tools: readonly string[],
    forgetOptions?: { readonly incarnation?: string | undefined },
  ): Promise<readonly string[] | undefined> {
    const sessions = peers.requireSessionStore();
    if (core.runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot forget grants: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    let forgotten: readonly string[] | undefined;
    await sessions.update(
      id,
      (session) => {
        if (session === undefined) return undefined;
        if (
          forgetOptions?.incarnation !== undefined &&
          session.incarnation !== forgetOptions.incarnation
        ) {
          return undefined;
        }
        const without = withoutGrantsFor(session.metadata, tools);
        forgotten = without.forgotten;
        // Nothing to forget is no write: undefined leaves the session as it is.
        return without.metadata === session.metadata
          ? undefined
          : { ...session, metadata: without.metadata };
      },
      { refreshActivity: false },
    );
    return forgotten;
  }

  return {
    deliverHumanWaitDecision,
    signalSession,
    submitSessionInput,
    retractSessionInput,
    forgetSessionGrants,
  };
}
