/**
 * The reviews of workflow files (COR-2009): an instance waiting at an `await-signal` step that its
 * file writes with `"review": true` (the builder's "Wait for a person") is a review that lists in
 * `bureau.reviews.list()`, waiting on the workflow's owner, until someone resolves it. A step
 * without `review` is a signal wait: the instance waits on it all the same, and nothing lists it.
 *
 * Weft never sees `review`: Bureau strips it before handing Weft the document, so the engine knows
 * only that an instance waits for a signal. This module joins the two. The engine says which
 * instances wait, on which signal, and at which step (the timeline's `stepIndex` of the running
 * `wait-signal` entry's `documentStep`, which is the canonical preorder index of the document
 * step); the file says whether that step is a review. A wait inside a race (an `await-signal` with
 * a `timeout`) or a parallel round has a bare `race` or `parallel` timeline entry, so its step and
 * address come from the history event that opened it, and a parallel round can hold several reviews
 * at once. The file is the one the instance runs on, read through
 * {@link WorkflowReviewWaitsDependencies.revisionSteps}: the newest saved version whose Weft
 * revision is the instance's.
 *
 * Nothing is persisted here. The cache is derived from the engine, filled by a sweep at start
 * (a wait recovered after a restart fires no `signal:waiting`, so the sweep is how a review
 * survives one) and kept current by the engine's signal and terminal events. `list` is synchronous
 * because `bureau.reviews.list()` is; every resolution asks the engine again, through the same
 * fenced path a `bureau.run()` run's human wait takes (`run-human-waits.ts`), so a stale entry can
 * never deliver twice.
 *
 * A review's id is `human-wait:<runId>:<signal>:<stepIndex>`. A document runs each step once, so
 * the id is the same across a restart and in every process, which the delivery id derived from it
 * relies on.
 *
 * @module workflow-review-waits
 */

import type {
  RegistryAgnosticEngine,
  WorkflowEvent,
  WorkflowState,
  WorkflowTimelineEntry,
} from '@lostgradient/weft';

import type { DiagnosticSink } from './bureau-types/options';
import type { PendingHumanWaitReview } from './bureau-types/reviews';
import { workflowFileStepsInCanonicalOrder, type WorkflowFileStep } from './workflow-file';

/** The steps as written of the revision an instance runs on. */
export interface WorkflowRevisionSteps {
  /** The workflow's identifier. */
  readonly workflow: string;
  /** The workflow's `title`, or `null`. */
  readonly title: string | null;
  /** The steps as written, `title` and `review` included. */
  readonly steps: readonly WorkflowFileStep[];
}

/** What the module reads of the engine. */
export type WorkflowReviewEngine = Pick<
  RegistryAgnosticEngine,
  | 'get'
  | 'getTimeline'
  | 'getEvents'
  | 'addEventListener'
  | 'removeEventListener'
  | 'subscribeWorkflowFeedCommits'
>;

/** What {@link createWorkflowReviewWaits} reads from the Bureau around it. */
export interface WorkflowReviewWaitsDependencies {
  /** The durable engine, or `undefined` for a Bureau without one, which has no workflow files. */
  readonly engine: () => WorkflowReviewEngine | undefined;
  /**
   * The steps of the revision an instance of engine type `type` runs on, pinned to
   * `workflowVersion`; `undefined` when `type` is no workflow file's or the revision is unknown.
   */
  readonly revisionSteps: (
    type: string,
    workflowVersion: string,
  ) => Promise<WorkflowRevisionSteps | undefined>;
  /** The ids of every instance of a workflow file that has not finished, for the start sweep. */
  readonly inFlightRunIds: () => Promise<readonly string[]>;
  /** The clock a review's age is read against. */
  readonly now: () => number;
  /** Told of a review that appeared while this process was running, so it is announced once. */
  readonly announce: (review: PendingHumanWaitReview) => void;
  /**
   * Told that the module holds nothing more of `runId`: its instance settled. The human-wait
   * resolver forgets the reviews it resolved for the run.
   */
  readonly released: (runId: string) => void;
  /** Registers background work, so shutdown and tests can wait for it. */
  readonly track: (promise: Promise<unknown>, label: string) => void;
  readonly diagnose: DiagnosticSink;
}

/** One review this process holds. */
interface Wait {
  readonly runId: string;
  readonly workflow: string;
  readonly title: string | null;
  readonly stepIndex: number;
  readonly stepAddress: string | undefined;
  readonly stepTitle: string | null;
  readonly signalName: string;
  readonly requestedAt: number;
}

/** The statuses an instance can still be waiting in. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'suspended']);

/** The engine events after which an instance's wait may have begun, ended, or settled. */
const REFRESH_EVENTS = ['signal:waiting', 'signal:delivered'] as const;
/** The events that show an instance that held a review has moved on to a step that is not a wait. */
const MOVED_ON_EVENTS = ['activity:started'] as const;
const TERMINAL_EVENTS = [
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:timed-out',
] as const;

/** The id of the review a wait at `stepIndex` on `signalName` of `runId` is. */
export function workflowReviewId(
  runId: string,
  signalName: string,
  stepIndex: number,
  stepAddress?: string,
): string {
  return `human-wait:${runId}:${signalName}:${stepAddress ?? String(stepIndex)}`;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Whether `step` is an `await-signal` on `signalName`. */
function awaits(step: WorkflowFileStep | undefined, signalName: string): boolean {
  return step?.['kind'] === 'await-signal' && step['signal'] === signalName;
}

/** A step an instance waits at. */
interface WaitingStep {
  readonly stepIndex: number;
  readonly signalName: string;
  readonly since: number;
  readonly stepAddress: string | undefined;
}

/**
 * The `await-signal` step the latest `signal-waiting` event of `events` names for `signalName`, with
 * the address of the wait in a race or a parallel round. The engine records that event as the wait
 * starts, whatever operation it is nested in, so it is the one place a wait with a `timeout` or in
 * a `parallel` branch says which document step and iteration it is. `undefined` when no event names
 * a step of the file that awaits `signalName`.
 */
function openedWait(
  events: readonly WorkflowEvent[],
  signalName: string,
  ordered: ReturnType<typeof workflowFileStepsInCanonicalOrder>,
): WaitingStep | undefined {
  const opened = events.findLast(
    (event) => event.type === 'file-workflow:signal-waiting' && event.data['signal'] === signalName,
  );
  const stepIndex = opened?.data['step'];
  if (typeof stepIndex !== 'number' || !awaits(ordered[stepIndex]?.step, signalName)) {
    return undefined;
  }
  const address = opened?.data['stepAddress'];
  return {
    stepIndex,
    signalName,
    since: opened?.timestamp ?? 0,
    stepAddress: typeof address === 'string' ? address : undefined,
  };
}

/**
 * The steps an instance waits at, and since when. A top-level wait is the running `wait-signal`
 * entry of the timeline, whose `documentStep` is the step's index in the file, when that step
 * awaits the entry's signal. A wait inside a race (a `timeout`) or a parallel round has a bare
 * `race` or `parallel` entry, so each signal the instance waits for is read from the history
 * event that opened its wait ({@link openedWait}): a parallel round can wait at several steps at
 * once. Otherwise, the one `await-signal` step on a signal when exactly one step names it. A
 * signal none of these places is left out.
 */
async function waitingSteps(
  engine: WorkflowReviewEngine,
  runId: string,
  state: WorkflowState,
  timeline: readonly WorkflowTimelineEntry[],
  steps: readonly WorkflowFileStep[],
): Promise<readonly WaitingStep[]> {
  const waiting = state.waitingForSignals ?? [];
  const ordered = workflowFileStepsInCanonicalOrder(steps);
  const entry = timeline.findLast(
    (candidate) =>
      candidate.operationType === 'wait-signal' &&
      candidate.status === 'running' &&
      waiting.includes(candidate.operationLabel),
  );
  if (
    entry?.documentStep !== undefined &&
    awaits(ordered[entry.documentStep]?.step, entry.operationLabel)
  ) {
    return [
      {
        stepIndex: entry.documentStep,
        signalName: entry.operationLabel,
        since: entry.timestamp,
        stepAddress: entry.documentStepAddress,
      },
    ];
  }
  const events = await engine.getEvents(runId);
  const found: WaitingStep[] = [];
  for (const signalName of waiting) {
    const opened = openedWait(events, signalName, ordered);
    if (opened !== undefined) {
      found.push(opened);
      continue;
    }
    const indices = ordered.flatMap(({ step, index }) => (awaits(step, signalName) ? [index] : []));
    if (indices.length === 1) {
      found.push({
        stepIndex: indices[0]!,
        signalName,
        since: entry?.timestamp ?? state.updatedAt,
        stepAddress: entry?.documentStepAddress,
      });
    }
  }
  return found;
}

/** Build the module. Call {@link WorkflowReviewWaits.start} once the workflow files are registered. */
export function createWorkflowReviewWaits(dependencies: WorkflowReviewWaitsDependencies) {
  /** The reviews each instance waits at, by run id: one, or several when a parallel round waits at many. */
  const waits = new Map<string, readonly Wait[]>();
  /** Reviews resolved here: the engine may not yet say so, and a refresh in flight must not revive them. */
  const resolved = new Set<string>();
  /** Reviews already announced, or found by the start sweep, which were announced before it. */
  const announced = new Set<string>();
  /** Each run's refresh in flight, so two refreshes of one run apply in order. */
  const refreshing = new Map<string, Promise<void>>();
  /** The commit feed of each run that holds a review, by run id: see {@link follow}. */
  const following = new Map<string, () => void>();
  let stopListening: (() => void) | undefined;

  function reviewOf(wait: Wait): PendingHumanWaitReview {
    return {
      kind: 'human-wait',
      id: workflowReviewId(wait.runId, wait.signalName, wait.stepIndex, wait.stepAddress),
      runId: wait.runId,
      agentName: undefined,
      signalName: wait.signalName,
      prompt: wait.stepTitle ?? undefined,
      workflow: {
        id: wait.workflow,
        ...(wait.title === null ? {} : { title: wait.title }),
        step: wait.stepIndex + 1,
        ...(wait.stepTitle === null ? {} : { stepTitle: wait.stepTitle }),
      },
      requestedAt: wait.requestedAt,
      ageMilliseconds: dependencies.now() - wait.requestedAt,
      status: 'pending',
    };
  }

  function idOf(wait: Wait): string {
    return workflowReviewId(wait.runId, wait.signalName, wait.stepIndex, wait.stepAddress);
  }

  /**
   * Follow each commit of a run that holds a review. A wait that lost its race to its timeout ends
   * with no signal event of its own, and the step after it may start no activity (a sleep, or a
   * sibling's wait in a parallel step), so the commit that follows it is what says it ended: the
   * engine settles the wait's end before the operation that follows it commits.
   */
  function follow(runId: string): void {
    const engine = dependencies.engine();
    if (engine === undefined || following.has(runId)) return;
    following.set(
      runId,
      engine.subscribeWorkflowFeedCommits(runId, 'events', () => {
        if (waits.has(runId)) refreshInBackground(runId, 'quiet');
      }),
    );
  }

  function unfollow(runId: string): void {
    following.get(runId)?.();
    following.delete(runId);
  }

  function drop(runId: string): void {
    waits.delete(runId);
    unfollow(runId);
  }

  function settle(runId: string): void {
    waits.delete(runId);
    unfollow(runId);
    for (const ids of [resolved, announced]) {
      for (const id of ids) if (id.startsWith(`human-wait:${runId}:`)) ids.delete(id);
    }
    dependencies.released(runId);
  }

  /** The reviews the engine says `runId` waits at now: none when it waits at no review. */
  async function read(engine: WorkflowReviewEngine, runId: string): Promise<readonly Wait[]> {
    const state = await engine.get(runId);
    if (state === null || !LIVE_STATUSES.has(state.status)) return [];
    if ((state.waitingForSignals?.length ?? 0) === 0) return [];
    const revision = await dependencies.revisionSteps(
      state.type,
      state.versionTuple.workflowVersion,
    );
    if (revision === undefined) return [];
    const ordered = workflowFileStepsInCanonicalOrder(revision.steps);
    const found = await waitingSteps(
      engine,
      runId,
      state,
      await engine.getTimeline(runId),
      revision.steps,
    );
    return found.flatMap((step): Wait[] => {
      const written = ordered[step.stepIndex]?.step;
      if (written?.['review'] !== true) return [];
      return [
        {
          runId,
          workflow: revision.workflow,
          title: revision.title,
          stepIndex: step.stepIndex,
          stepTitle: stringOf(written['title']),
          signalName: step.signalName,
          requestedAt: step.since,
          stepAddress: step.stepAddress,
        },
      ];
    });
  }

  /**
   * Read `runId` from the engine again and hold the review it waits at, if any. `mode` says what
   * becomes of a review not announced yet: `announce` tells
   * {@link WorkflowReviewWaitsDependencies.announce} of it (the wait began just now), `recovered`
   * counts it as announced (the start sweep found it, so it began before this process), and `quiet`
   * leaves it for the `signal:waiting` that announces it.
   */
  function refresh(runId: string, mode: 'announce' | 'recovered' | 'quiet'): Promise<void> {
    const previous = refreshing.get(runId) ?? Promise.resolve();
    const next = (async () => {
      // A refresh that failed was reported by its caller; this one reads the engine afresh.
      await previous.catch(() => undefined);
      const engine = dependencies.engine();
      if (engine === undefined) return;
      const found = await read(engine, runId);
      // A wait already held keeps the time it was first read at: the engine records a fresh
      // timeline entry for the wait each time the run is recovered, which would say it began then.
      const earlier = new Map((waits.get(runId) ?? []).map((wait) => [idOf(wait), wait]));
      const held = found
        .filter((wait) => !resolved.has(idOf(wait)))
        .map((wait) => {
          const before = earlier.get(idOf(wait));
          return before === undefined ? wait : { ...wait, requestedAt: before.requestedAt };
        });
      if (held.length === 0) {
        drop(runId);
        return;
      }
      waits.set(runId, held);
      follow(runId);
      for (const wait of held) {
        const id = idOf(wait);
        if (mode === 'quiet' || announced.has(id)) continue;
        announced.add(id);
        if (mode === 'announce') dependencies.announce(reviewOf(wait));
      }
    })();
    const settled = next.finally(() => {
      if (refreshing.get(runId) === settled) refreshing.delete(runId);
    });
    refreshing.set(runId, settled);
    return settled;
  }

  /** Refresh `runId` in the background, reporting a failure rather than throwing it. */
  function refreshInBackground(runId: string, mode: 'announce' | 'quiet'): void {
    dependencies.track(
      refresh(runId, mode).catch((error: unknown) => {
        dependencies.diagnose({
          level: 'error',
          scope: 'workflow-files',
          message:
            `[bureau] Could not read whether workflow instance "${runId}" waits on a review: ` +
            (error instanceof Error ? error.message : String(error)),
        });
      }),
      'workflow-review-refresh',
    );
  }

  /**
   * Listen to the engine and hold the review every in-flight instance waits at. Resolves once the
   * sweep has read them all; an instance that cannot be read is reported and left unlisted.
   */
  async function start(): Promise<void> {
    const engine = dependencies.engine();
    if (engine === undefined || stopListening !== undefined) return;
    const onWaitChanged = (event: Event): void => {
      const runId = (event as Event & { workflowId?: unknown }).workflowId;
      if (typeof runId === 'string')
        refreshInBackground(runId, event.type === 'signal:waiting' ? 'announce' : 'quiet');
    };
    // A wait that lost its race to the timeout ends with no signal event, but the instance goes on
    // to its next step, which starts an activity or waits again: either tells a held review it ended.
    const onMovedOn = (event: Event): void => {
      const runId = (event as Event & { workflowId?: unknown }).workflowId;
      if (typeof runId === 'string' && waits.has(runId)) refreshInBackground(runId, 'quiet');
    };
    const onSettled = (event: Event): void => {
      const runId = (event as Event & { workflowId?: unknown }).workflowId;
      if (typeof runId === 'string') settle(runId);
    };
    for (const type of REFRESH_EVENTS) engine.addEventListener(type, onWaitChanged);
    for (const type of MOVED_ON_EVENTS) engine.addEventListener(type, onMovedOn);
    for (const type of TERMINAL_EVENTS) engine.addEventListener(type, onSettled);
    stopListening = () => {
      for (const type of REFRESH_EVENTS) engine.removeEventListener(type, onWaitChanged);
      for (const type of MOVED_ON_EVENTS) engine.removeEventListener(type, onMovedOn);
      for (const type of TERMINAL_EVENTS) engine.removeEventListener(type, onSettled);
    };
    let runIds: readonly string[];
    try {
      runIds = await dependencies.inFlightRunIds();
    } catch (error) {
      dependencies.diagnose({
        level: 'error',
        scope: 'workflow-files',
        message:
          '[bureau] Could not list the workflow instances in flight, so none of their reviews is listed until it is read again: ' +
          (error instanceof Error ? error.message : String(error)),
      });
      return;
    }
    await Promise.all(
      runIds.map((runId) =>
        refresh(runId, 'recovered').catch((error: unknown) => {
          dependencies.diagnose({
            level: 'error',
            scope: 'workflow-files',
            message:
              `[bureau] Could not read whether workflow instance "${runId}" waits on a review: ` +
              (error instanceof Error ? error.message : String(error)),
          });
        }),
      ),
    );
  }

  /** Every review held, oldest first. */
  function list(): PendingHumanWaitReview[] {
    return [...waits.values()]
      .flat()
      .filter((wait) => !resolved.has(idOf(wait)))
      .toSorted((left, right) => left.requestedAt - right.requestedAt)
      .map(reviewOf);
  }

  /** The review held under `id`, if any. */
  function find(id: string): PendingHumanWaitReview | undefined {
    if (resolved.has(id)) return undefined;
    for (const held of waits.values()) {
      const wait = held.find((candidate) => idOf(candidate) === id);
      if (wait !== undefined) return reviewOf(wait);
    }
    return undefined;
  }

  /**
   * The review under `id`: one held, or, for a `human-wait:` id whose run this process does not
   * hold yet (its wait was recorded a moment ago, or another process started it), the one its run
   * waits at now. `undefined` for a review resolved here and for any other id.
   */
  async function lookup(id: string): Promise<PendingHumanWaitReview | undefined> {
    const held = find(id);
    if (held !== undefined || resolved.has(id) || !id.startsWith('human-wait:')) return held;
    const [, runId] = id.split(':');
    if (runId === undefined || runId === '' || waits.has(runId)) return undefined;
    await refresh(runId, 'quiet');
    return find(id);
  }

  return {
    start,
    list,
    find,
    lookup,
    /** The reviews held for `runId`: none, one, or several when a parallel round waits at many. */
    ofRun: (runId: string): PendingHumanWaitReview[] => list().filter((r) => r.runId === runId),
    /** Read `runId` from the engine again, as after a resolution that was refused. */
    refresh: (runId: string): Promise<void> => refresh(runId, 'quiet'),
    /**
     * Stop listing `id`: it was resolved here. Kept out of the list until its instance settles,
     * whatever a refresh that read the engine before the delivery says.
     */
    markResolved(id: string): void {
      resolved.add(id);
      for (const [runId, held] of waits) {
        const rest = held.filter((wait) => idOf(wait) !== id);
        if (rest.length === 0) drop(runId);
        else if (rest.length !== held.length) waits.set(runId, rest);
      }
    },
    /** Stop listening to the engine. */
    close(): void {
      stopListening?.();
      stopListening = undefined;
      for (const runId of following.keys()) unfollow(runId);
    },
  };
}

/** The reviews of workflow files that a Bureau holds. */
export type WorkflowReviewWaits = ReturnType<typeof createWorkflowReviewWaits>;
