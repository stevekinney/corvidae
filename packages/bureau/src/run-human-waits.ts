/**
 * The human-wait reviews of runs that have no session (COR-1577): a `bureau.run()` run that
 * calls `requestHumanInput` parks on a signal, appears in `reviews.list()` as a review
 * addressed by its run id, and resumes after `reviews.resolve`.
 *
 * Bureau's session reviews keep their state in session metadata, which a catalog run does not
 * have, so this module adds no persisted state of its own. The engine already holds it:
 * `WorkflowState.waitingForSignals` says whether a run is still parked on a signal (it survives
 * a restart and clears when the signal is delivered), the checkpoint holds the park's ordinal and
 * prompt, and `engine.signal(…, { signalId })` delivers once however often it is retried, under a
 * delivery id derived from the review id ({@link humanWaitDeliveryId}). The
 * map kept here is derived from those and is never trusted: every resolve asks the engine first.
 *
 * Counting the parks goes through `human-wait-parks.ts`, the same code the session path uses, so
 * a park gets the same review id on every path.
 *
 * A peer derives the park (COR-1579). Several Bureau processes can share one durable store, and
 * the process asked about a review need not be the one that holds its run. A run this process
 * does not hold has no entry here, so {@link RunHumanWaits.derive} reads it from durable state
 * alone, the way {@link RunHumanWaits.restore} does after a restart: the park, its ordinal and its
 * prompt from the checkpoint's last step (`countCheckpointParks`), and whether it is still pending
 * from `engine.get(runId).waitingForSignals`. A run is a catalog run when
 * `classifyCatalogRecoveredRun` finds its recovery record, and a session run otherwise, whose
 * session is the durable run input's `sessionId`. A peer resolves a derived catalog park here, and
 * a derived session park through the session path. Both fence the decision with the durable
 * record of `review-decision-record.ts` before delivering, so two processes deciding one park
 * decide it once.
 *
 * @module run-human-waits
 */

import { CompletableEventTarget } from '@lostgradient/lifecycle';
import {
  type CombinedOperativeEventMap,
  type HumanInputSchema,
  humanInputSchemaOf,
  isScheduledAgentRunInput,
  type DurableRunDeps,
  HumanWaitParkedEvent,
} from '@lostgradient/operative';
import type { RegistryAgnosticEngine, WorkflowState } from '@lostgradient/weft';

import {
  type CheckpointStep,
  countCheckpointParks,
  humanWaitParkOrdinal,
  type ParkAction,
} from './park-ordinals';
import {
  boundedReviewId,
  createReviewDecisionRecords,
  digestReviewDelivery,
  type ReviewDecisionRecords,
  type ReviewDecisionRequest,
} from './review-decision-record';
import type { SecretAnswerAuditEntry } from './secret-answers';
import type { RunAttribution } from './serialization';
import type {
  DiagnosticSink,
  PendingHumanWaitReview,
  ResolveReviewInput,
  ResolveReviewResult,
} from './types';

/** The sentinel a denied or rejected park resumes with; identical to the session path's. */
export function humanWaitDenialPayload(
  decision: 'deny' | 'reject',
  reason: string | undefined,
): Record<string, unknown> {
  return decision === 'reject'
    ? { __abRejected: true, reason }
    : { __abDenied: true, ...(reason !== undefined ? { reason } : {}) };
}

/**
 * The id a decision is delivered to Weft under, derived from the review id. The review id embeds
 * the model-chosen `signalName`, so it can exceed Weft's 128-byte `signalId` limit; it stays the
 * review's address on the wire either way. The review id itself is used when it fits, and a
 * fixed-length hash of it otherwise ({@link boundedReviewId}). The derivation is deterministic, so
 * a retry, including one made after a restart or from another process, is delivered under the
 * same id and Weft's accepted-response marker deduplicates it.
 */
export function humanWaitDeliveryId(reviewId: string): string {
  return boundedReviewId(reviewId, 'human-wait');
}

/** The decision record a human-wait resolution claims: round 0, digesting the delivered payload. */
export function humanWaitDecisionRequest(
  reviewId: string,
  input: ResolveReviewInput,
  payload: unknown,
): ReviewDecisionRequest {
  return {
    reviewId,
    round: 0,
    decision: input.decision,
    principal: input.principal,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    digest: digestReviewDelivery(payload),
  };
}

/** The payload a human-wait decision delivers on its signal. */
export function humanWaitDecisionPayload(input: ResolveReviewInput): unknown {
  return input.decision === 'approve'
    ? input.payload
    : humanWaitDenialPayload(input.decision, input.reason);
}

type StoredRun = {
  readonly status: string;
  readonly actions: ReadonlyArray<ParkAction & { readonly timestamp: number }>;
};

/** What the module reads from the Bureau around it. */
export type RunHumanWaitsDependencies = {
  /** The run store; a registered `bureau.run()` run has its actions here while it lives. */
  readonly store: { getRun(runId: string): StoredRun | undefined };
  /** Ids of the `bureau.run()` runs registered on the store. */
  readonly catalogRunIds: ReadonlySet<string>;
  readonly runAttribution: ReadonlyMap<string, RunAttribution>;
  readonly engine: () => RegistryAgnosticEngine | undefined;
  readonly checkpointSteps: (runId: string) => Promise<readonly CheckpointStep[]>;
  readonly now: () => number;
  /**
   * Announces the decision, and writes its audit record when `writeAudit` is set: only the caller
   * whose decision record turned `recorded` writes one. The session path's counterpart.
   */
  readonly recordDecision: (
    review: PendingHumanWaitReview,
    decision: ResolveReviewInput['decision'],
    principal: string,
    reason: string | undefined,
    writeAudit: boolean,
    secretAnswers: readonly SecretAnswerAuditEntry[],
  ) => Promise<void>;
  /**
   * Stores the sealed secret answers a payload carries for the run that asked, and returns the
   * payload to deliver, each reduced to its `{ secretRef }`, with what the audit entry says of them
   * (COR-1920). Called after the decision is claimed and before the signal is sent.
   */
  readonly prepareDelivery: (
    review: PendingHumanWaitReview,
    payload: unknown,
    principal: string,
    decision: ResolveReviewInput['decision'],
  ) => Promise<{ readonly payload: unknown; readonly audit: readonly SecretAnswerAuditEntry[] }>;
  /**
   * The durable decision record every resolution claims before it delivers. Without one,
   * resolution is fenced by this process's own guards alone.
   */
  readonly decisions?: ReviewDecisionRecords;
  /**
   * Whether a run is a `bureau.run()` run, read from its durable recovery record. Without it no
   * park is derived for a run this process does not hold.
   */
  readonly classifyRun?: (runId: string) => Promise<{
    isCatalogRun: boolean;
    attribution?: { agentName: string; principal?: string };
  }>;
  /**
   * Told that this process no longer holds a restored park of `runId`: it was answered here,
   * closed by another process, or forgotten with its run (COR-1621). A host that follows the
   * run's durable history for such a park stops once it holds no other review of the run.
   */
  readonly released?: ((runId: string) => void) | undefined;
  readonly createError: (message: string, code: 'BAD_REQUEST' | 'CONFLICT' | 'NOT_FOUND') => Error;
  /** The error for a Bureau with no durable engine to deliver through. */
  readonly durableNotConfigured: () => Error;
  readonly diagnose: DiagnosticSink;
};

type Wait = {
  readonly runId: string;
  readonly signalName: string;
  readonly prompt: string | undefined;
  /** The schema the author configured for the signal, when the park carries one. */
  readonly inputSchema?: HumanInputSchema | undefined;
  readonly ordinal: number;
  readonly requestedAt: number;
  readonly agentName: string | undefined;
  /**
   * The session a schedule fire runs in (COR-1596); absent for a `bureau.run()` run, which has
   * none, and for a park {@link derive} reads from durable state, which names its session itself.
   */
  readonly sessionId?: string | undefined;
};

/** What a registered run is known by besides its id. */
export type RunHumanWaitTarget = {
  readonly agentName: string | undefined;
  /** Set for a schedule fire (COR-1596), whose reviews name the session it runs in. */
  readonly sessionId?: string | undefined;
  /** Told of each park the run makes after it is attached, so the host can announce it (COR-1596). */
  readonly announce?: ((reviewId: string, signalName: string) => void) | undefined;
};

/** Statuses a workflow can still be parked in; anything else has settled. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'suspended']);

export function createRunHumanWaits(dependencies: RunHumanWaitsDependencies) {
  const { store, catalogRunIds, runAttribution, createError } = dependencies;
  const decisions = dependencies.decisions ?? createReviewDecisionRecords(undefined);
  /** Parks a recovered run's checkpoint held, restored by {@link restore}. */
  const restored = new Map<string, Wait>();
  /** Parks committed before this process, so the first live park numbers after them. */
  const baselines = new Map<string, number>();
  /** Reviews resolved in this process: the run may still be going, so the store would still show them. */
  const resolved = new Set<string>();
  const resolving = new Set<string>();
  /** The waits {@link derive} read as a schedule fire's, which resolve through the engine. */
  const derivedFireWaits = new WeakSet<object>();

  function reviewIdFor(wait: Wait): string {
    return `human-wait:${wait.runId}:${wait.signalName}:${wait.ordinal}`;
  }

  function liveWaits(): Wait[] {
    const waits: Wait[] = [];
    for (const runId of catalogRunIds) {
      const run = store.getRun(runId);
      if (run === undefined || run.status !== 'running') continue;
      let parked: StoredRun['actions'][number] | undefined;
      for (let index = run.actions.length - 1; index >= 0; index -= 1) {
        const action = run.actions[index];
        if (action?.type === HumanWaitParkedEvent.type) {
          parked = action;
          break;
        }
      }
      if (parked === undefined) continue;
      const detail =
        parked.detail !== null && typeof parked.detail === 'object'
          ? (parked.detail as Record<string, unknown>)
          : undefined;
      const signalName = detail?.['signalName'];
      if (typeof signalName !== 'string' || signalName.length === 0) continue;
      const prompt = detail?.['prompt'];
      const inputSchema = humanInputSchemaOf(detail?.['inputSchema']);
      waits.push({
        runId,
        signalName,
        prompt: typeof prompt === 'string' ? prompt : undefined,
        ...(inputSchema === undefined ? {} : { inputSchema }),
        ordinal: humanWaitParkOrdinal(run.actions, baselines.get(runId) ?? 0),
        requestedAt: parked.timestamp,
        agentName: runAttribution.get(runId)?.agentName,
        sessionId: undefined,
      });
    }
    return waits;
  }

  function toReview(wait: Wait): PendingHumanWaitReview {
    return {
      kind: 'human-wait',
      id: reviewIdFor(wait),
      runId: wait.runId,
      agentName: wait.agentName,
      ...(wait.sessionId === undefined ? {} : { sessionId: wait.sessionId }),
      signalName: wait.signalName,
      prompt: wait.prompt,
      ...(wait.inputSchema === undefined ? {} : { inputSchema: wait.inputSchema }),
      requestedAt: wait.requestedAt,
      ageMilliseconds: dependencies.now() - wait.requestedAt,
      status: 'pending',
    };
  }

  function pending(): Wait[] {
    return [...liveWaits(), ...restored.values()].filter(
      (wait) => !resolved.has(reviewIdFor(wait)),
    );
  }

  function list(): PendingHumanWaitReview[] {
    return pending().map(toReview);
  }

  function find(id: string): PendingHumanWaitReview | undefined {
    return list().find((review) => review.id === id);
  }

  /**
   * Re-derive the park of a run a restart recovered, from its checkpoint, if it is still
   * outstanding in the engine. Called before the run's workflow is allowed to advance.
   */
  async function restore(runId: string, target: RunHumanWaitTarget): Promise<void> {
    const engine = dependencies.engine();
    if (engine === undefined) return;
    let steps: readonly CheckpointStep[];
    try {
      steps = await dependencies.checkpointSteps(runId);
    } catch (error) {
      dependencies.diagnose({
        level: 'error',
        scope: 'recovery',
        message:
          `[bureau] Could not read checkpoint steps for recovered run "${runId}" while ` +
          `restoring a human-wait review: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const parks = countCheckpointParks(steps);
    if (steps.length > 0) baselines.set(runId, parks.baseline);
    const outstanding = parks.outstanding;
    if (outstanding === undefined) return;
    let state: WorkflowState | null;
    try {
      state = await engine.get(runId);
    } catch (error) {
      // A failed read must not fail the run's recovery. This one review is left unlisted: the run
      // is still parked in the engine, and the next restart reads the engine again.
      dependencies.diagnose({
        level: 'error',
        scope: 'recovery',
        message:
          `[bureau] Could not read the workflow state of recovered run "${runId}" while ` +
          'restoring a human-wait review, so the review is not listed: ' +
          (error instanceof Error ? error.message : String(error)),
      });
      return;
    }
    if (state === null || !state.waitingForSignals?.includes(outstanding.signalName)) return;
    restored.set(runId, {
      runId,
      signalName: outstanding.signalName,
      prompt: outstanding.prompt,
      ...(outstanding.inputSchema === undefined ? {} : { inputSchema: outstanding.inputSchema }),
      ordinal: outstanding.ordinal,
      requestedAt: dependencies.now(),
      agentName: target.agentName,
      sessionId: target.sessionId,
    });
  }

  /**
   * Hear the parks a recovered run makes from here on. A recovered catalog run has no `ActiveRun`
   * on the store, so its services get an emitter of their own to carry the workflow's events, and
   * each park it reports is numbered by the same rule as every other, continuing from the parks
   * the checkpoint committed.
   */
  function observe(runId: string, target: RunHumanWaitTarget, services: DurableRunDeps): void {
    const seeded = restored.get(runId);
    const actions: ParkAction[] =
      seeded === undefined
        ? []
        : [
            {
              type: HumanWaitParkedEvent.type,
              detail: {
                signalName: seeded.signalName,
                parkOrdinal: seeded.ordinal,
                ...(seeded.prompt === undefined ? {} : { prompt: seeded.prompt }),
                ...(seeded.inputSchema === undefined ? {} : { inputSchema: seeded.inputSchema }),
              },
            },
          ];
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    emitter.addEventListener('step.started', () => {
      actions.push({ type: 'step.started', detail: undefined });
    });
    emitter.addEventListener(HumanWaitParkedEvent.type, (event) => {
      actions.push({
        type: HumanWaitParkedEvent.type,
        detail: {
          signalName: event.signalName,
          ...(event.prompt === undefined ? {} : { prompt: event.prompt }),
          ...(event.inputSchema === undefined ? {} : { inputSchema: event.inputSchema }),
        },
      });
      restored.set(runId, {
        runId,
        signalName: event.signalName,
        prompt: event.prompt,
        ...(event.inputSchema === undefined ? {} : { inputSchema: event.inputSchema }),
        ordinal: humanWaitParkOrdinal(actions, baselines.get(runId) ?? 0),
        requestedAt: dependencies.now(),
        agentName: target.agentName,
        sessionId: target.sessionId,
      });
      target.announce?.(
        `human-wait:${runId}:${event.signalName}:${humanWaitParkOrdinal(actions, baselines.get(runId) ?? 0)}`,
        event.signalName,
      );
    });
    services.emitter = emitter;
  }

  /**
   * The one registration of a run's human waits that has no `ActiveRun` on the store: a recovered
   * `bureau.run()` run and every schedule fire, live or recovered (COR-1596). It restores the park
   * the run's checkpoint holds, then hears the parks it makes from here on.
   */
  async function attach(
    runId: string,
    target: RunHumanWaitTarget,
    services: DurableRunDeps,
  ): Promise<void> {
    await restore(runId, target);
    observe(runId, target, services);
  }

  /**
   * A review another process closed (COR-1613): this process's copy of the wait, restored or
   * heard, is stale, and is hidden from its list as one resolved here is.
   */
  function closedElsewhere(reviewId: string): void {
    for (const [runId, wait] of restored) {
      if (reviewIdFor(wait) === reviewId) {
        resolved.add(reviewId);
        restored.delete(runId);
        dependencies.released?.(runId);
      }
    }
  }

  /** Drop everything held for a run, once it has settled. */
  function forget(runId: string): void {
    const held = restored.delete(runId);
    baselines.delete(runId);
    for (const id of resolved) {
      if (id.startsWith(`human-wait:${runId}:`)) resolved.delete(id);
    }
    if (held) dependencies.released?.(runId);
  }

  /**
   * COR-1621, COR-1622 — what the engine says of the park this process restored for `runId`, read
   * from the engine rather than from events. `closed` names the park when the engine no longer
   * parks the run on it (the run settled, or its signal was delivered, by another process). A park
   * younger than `graceMilliseconds` is not asked about, because the engine records a park a
   * moment after the run announces it: `retryAt` is when its grace ends, the time to ask again.
   * Neither is set when the park is verified still standing, or there is none.
   */
  async function rereadClosed(
    runId: string,
    graceMilliseconds: number,
  ): Promise<{ readonly closed?: string; readonly retryAt?: number }> {
    const wait = restored.get(runId);
    const engine = dependencies.engine();
    if (wait === undefined || engine === undefined) return {};
    const graceEnds = wait.requestedAt + graceMilliseconds;
    // The exact end of the grace counts as ended: asked again at `retryAt`, the park is read.
    if (dependencies.now() < graceEnds) return { retryAt: graceEnds };
    const state = await engine.get(runId);
    if (settled(state) || !state?.waitingForSignals?.includes(wait.signalName)) {
      return { closed: reviewIdFor(wait) };
    }
    return {};
  }

  function settled(state: WorkflowState | null): boolean {
    return state === null || !LIVE_STATUSES.has(state.status);
  }

  /**
   * The park a run is still waiting on, read from durable state alone, for a run this process does
   * not hold (see the module doc). `undefined` when the run is not parked on a human wait.
   */
  async function derive(runId: string): Promise<PendingHumanWaitReview | undefined> {
    const engine = dependencies.engine();
    const classifyRun = dependencies.classifyRun;
    if (engine === undefined || classifyRun === undefined) return undefined;
    const state = await engine.get(runId);
    if (settled(state) || state === null || (state.waitingForSignals?.length ?? 0) === 0) {
      return undefined;
    }
    const outstanding = countCheckpointParks(await dependencies.checkpointSteps(runId)).outstanding;
    if (outstanding === undefined || !state.waitingForSignals?.includes(outstanding.signalName)) {
      return undefined;
    }
    const input =
      state.input !== null && typeof state.input === 'object'
        ? (state.input as Record<string, unknown>)
        : {};
    // COR-1613: a schedule fire's wait is a run's, resolved through the engine by run id, whatever
    // session it runs in. Its durable input is a scheduled agent run's, which a session run's and
    // a catalog run's are not.
    if (isScheduledAgentRunInput(input)) {
      const scheduleId = typeof input.scheduleId === 'string' ? input.scheduleId.trim() : '';
      const fireSessionId =
        input.sessionId ?? (scheduleId === '' ? undefined : `sched-${scheduleId}-${runId}`);
      const fireReview: PendingHumanWaitReview = {
        ...toReview({
          runId,
          signalName: outstanding.signalName,
          prompt: outstanding.prompt,
          ...(outstanding.inputSchema === undefined
            ? {}
            : { inputSchema: outstanding.inputSchema }),
          ordinal: outstanding.ordinal,
          requestedAt: state.updatedAt,
          agentName: input.agentName,
          sessionId: fireSessionId,
        }),
      };
      derivedFireWaits.add(fireReview);
      return fireReview;
    }
    const classification = await classifyRun(runId);
    const sessionId = input['sessionId'];
    if (!classification.isCatalogRun && typeof sessionId !== 'string') return undefined;
    const inputAgentName = input['agentName'];
    const wait: Wait = {
      runId,
      signalName: outstanding.signalName,
      prompt: outstanding.prompt,
      ...(outstanding.inputSchema === undefined ? {} : { inputSchema: outstanding.inputSchema }),
      ordinal: outstanding.ordinal,
      requestedAt: state.updatedAt,
      agentName:
        classification.attribution?.agentName ??
        (typeof inputAgentName === 'string' ? inputAgentName : undefined),
    };
    const review = toReview(wait);
    return classification.isCatalogRun ? review : { ...review, sessionId: sessionId as string };
  }

  /** Whether this process holds an entry for the run: a live run, or a restored park. */
  function holds(runId: string): boolean {
    return restored.has(runId) || (catalogRunIds.has(runId) && store.getRun(runId) !== undefined);
  }

  /**
   * Resolve a catalog park: one this process lists, or `derived`, the park of a run another process
   * holds (see {@link derive}). The decision is claimed in the durable record before anything is
   * delivered, so of two processes deciding one park differently one is refused with `CONFLICT`,
   * and of two deciding it alike both succeed, with one delivery and one audit entry.
   */
  async function resolve(
    input: ResolveReviewInput,
    derived?: PendingHumanWaitReview,
  ): Promise<ResolveReviewResult> {
    if (input.decision === 'reject' && (input.reason === undefined || input.reason.trim() === '')) {
      throw createError('reject requires a reason', 'BAD_REQUEST');
    }
    const review = find(input.id) ?? (derived?.id === input.id ? derived : undefined);
    if (review === undefined) {
      throw createError(`No pending review with id "${input.id}"`, 'NOT_FOUND');
    }
    if (resolving.has(review.id)) {
      throw createError(`Review with id "${review.id}" is already being resolved`, 'CONFLICT');
    }
    resolving.add(review.id);
    const payload = humanWaitDecisionPayload(input);
    const request = humanWaitDecisionRequest(review.id, input, payload);
    let secretAnswers: readonly SecretAnswerAuditEntry[] = [];
    try {
      const engine = dependencies.engine();
      if (engine === undefined) {
        throw dependencies.durableNotConfigured();
      }
      // The engine, not this map, says whether the run is still parked: the map can be stale
      // after a signal sent outside `reviews.resolve`, and is empty of anything resolved elsewhere.
      const state = await engine.get(review.runId);
      if (settled(state)) {
        forget(review.runId);
        throw createError(
          `Run "${review.runId}" has settled, so review "${review.id}" is closed`,
          'CONFLICT',
        );
      }
      if (!state?.waitingForSignals?.includes(review.signalName)) {
        resolved.add(review.id);
        throw createError(`Review "${review.id}" is no longer pending`, 'CONFLICT');
      }
      const claim = await decisions.claim(request);
      if (claim.outcome === 'conflict') {
        throw createError(
          `Review "${review.id}" was already resolved as "${claim.decision ?? 'unknown'}" by a different resolver`,
          'CONFLICT',
        );
      }
      // The delivery id is derived from the review id, so a retry after a failure, or a
      // same-decision caller re-driving a claim whose delivery threw, delivers once. A throw keeps
      // the claim (see `review-decision-record.ts`).
      const delivery = await dependencies.prepareDelivery(
        review,
        payload,
        input.principal,
        input.decision,
      );
      secretAnswers = delivery.audit;
      await engine.signal(review.runId, review.signalName, delivery.payload, {
        signalId: humanWaitDeliveryId(review.id),
      });
      resolved.add(review.id);
      restored.delete(review.runId);
      dependencies.released?.(review.runId);
    } finally {
      resolving.delete(review.id);
    }
    const writeAudit = await decisions.markRecorded(request);
    await dependencies.recordDecision(
      review,
      input.decision,
      input.principal,
      input.reason,
      writeAudit,
      secretAnswers,
    );
    return { id: review.id, kind: 'human-wait', decision: input.decision };
  }

  return {
    list,
    find,
    has: (id: string) => find(id) !== undefined,
    holds,
    derive,
    closedElsewhere,
    rereadClosed,
    /** Whether a wait {@link derive} returned is a schedule fire's (COR-1613). */
    isDerivedFire: (review: PendingHumanWaitReview) => derivedFireWaits.has(review),
    attach,
    forget,
    resolve,
  };
}

export type RunHumanWaits = ReturnType<typeof createRunHumanWaits>;
