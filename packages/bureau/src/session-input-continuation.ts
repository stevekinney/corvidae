import type { SessionInputDeliveryStore } from '@lostgradient/operative';
import type { ConditionalTextValueStore, Mailbox } from '@lostgradient/weft';
import { encodeStorageKeyComponent } from '@lostgradient/weft';

/**
 * COR-1476 — the invariant that a session with open input always has a live run,
 * so an input `submitSessionInput` called `admitted` is answered unless the user
 * stops the run.
 *
 * A run drains the session's input at each of its step boundaries and once more
 * when its last step would end it. Input that arrives after that final drain, or
 * that a run's budget left over, would otherwise wait for a run nobody has
 * started. When a run ends, {@link SessionInputContinuation.reconcile} looks at
 * the session: if no run is live and the mailbox still has open commands, it
 * starts a CONTINUATION run, with no prompt of its own, whose first step boundary
 * delivers the backlog in admission order. `submitSessionInput` runs the same
 * reconcile after admitting, and a marker per session that has had input, swept by
 * durable maintenance and boot recovery, repairs a reconcile that never ran.
 *
 * ## The ordering that closes the race, and what the marker is for
 *
 * The correctness of "admitted input is never stranded" is an ORDERING, not a
 * version check:
 *
 * - The ending run first makes itself not live. That write is the durable state
 *   `liveSessionRunIdsEverywhere` reads: its steering `run-ended` entry and the
 *   engine's terminal workflow state. Only after it is acknowledged does the run
 *   read the session's marker and then its mailbox.
 * - The submit side first commits the admission to the mailbox, and only then
 *   reads liveness.
 *
 * So one side always sees the other. If the submit side reads liveness before the
 * ending run's not-live write, the ending run's later mailbox read sees the
 * admitted input and starts the continuation. If it reads liveness after, it sees
 * no live run and reconciles itself. The two reconciles may both try to start a
 * continuation; the continuation key (below) lets exactly one.
 *
 * The marker `session-input-open:v1:{sessionId}` is only the sweep's index of
 * sessions that may have open input. The submit side bumps it, with a
 * compare-and-set that gives every write a fresh version, BEFORE it admits, so
 * admitted input is never missing from the index; a crash between the marker and
 * the admission leaves a marker over an empty mailbox, which the sweep removes.
 * Removing a marker is conditional (read its version, read the mailbox, delete
 * only if the mailbox is idle and the version is unchanged), but the version check
 * alone is not what makes it safe: an ending run can read the new version, read an
 * empty mailbox, and have the input admitted before it deletes. That is why the
 * submit-side reconcile never returns early because its session is unlisted, and
 * re-creates the marker whenever it finds open input.
 *
 * ## One continuation at a time
 *
 * `session-input-continuation:v1:{sessionId}` holds the continuation run being
 * started or running and how many continuations have failed in a row. It is
 * written only by compare-and-set, so concurrent reconciles start one run; the
 * losers do nothing. A key naming a run that is not live and was written longer
 * ago than a run's start window is stale and is taken over.
 *
 * ## The loop guard
 *
 * A continuation that ends in error without promoting anything counts as a
 * failure, as does one that cannot be started and one that ends with the input it
 * was started for still open. After two in a row the open commands are rejected,
 * so the input's receipt reads `failed` rather than `accepted` forever. A
 * continuation that is aborted does not count, and an explicit stop starts none.
 */

/** How long a continuation may be starting before another reconcile may take it over. */
export const SESSION_INPUT_CONTINUATION_START_WINDOW_MS = 60_000;

/** Consecutive failed continuations after which the open input is rejected. */
export const SESSION_INPUT_CONTINUATION_FAILURE_LIMIT = 2;

/**
 * The `startedAtMs` of a continuation record whose run is over or never started:
 * a record with this value is stale by definition, carries only the failure
 * count forward, and is taken over by the next reconcile without waiting out the
 * start window.
 */
const SETTLED_STARTED_AT_MS = 0;

export const OPEN_SESSION_INPUT_STATES = [
  'accepted',
  'available',
  'claimed',
  'cancellation-requested',
] as const;
const CAS_ATTEMPTS = 20;
/** How many open receipts one batch of a backlog operation handles. */
export const SESSION_INPUT_BACKLOG_BATCH = 100;

const MARKER_PREFIX = 'session-input-open:v1:';
const markerKey = (sessionId: string) => `${MARKER_PREFIX}${encodeStorageKeyComponent(sessionId)}`;
const continuationKey = (sessionId: string) =>
  `session-input-continuation:v1:${encodeStorageKeyComponent(sessionId)}`;

interface ContinuationRecord {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly failures: number;
}

interface MarkerRecord {
  readonly sessionId: string;
  readonly version: number;
}

/** How a run ended. `stopped` is an explicit stop by the user: it starts nothing. */
export type SessionInputRunOutcome = 'completed' | 'error' | 'aborted' | 'stopped';

export interface SessionInputContinuationDependencies {
  readonly kv: ConditionalTextValueStore;
  readonly deliveryStore: SessionInputDeliveryStore;
  readonly nowMs: () => number;
  /** The session's current incarnation, or `undefined` when it no longer exists. */
  readonly incarnationOf: (sessionId: string) => Promise<string | undefined>;
  /** The session incarnation's live runs in every process, not counting `excludeRunId`. */
  readonly liveRunIds: (
    sessionId: string,
    incarnation: string,
    excludeRunId: string | undefined,
  ) => Promise<readonly string[]>;
  readonly mailboxOf: (sessionId: string) => Mailbox | undefined;
  /** Starts a continuation run with the given id, through the ordinary run pipeline, with no prompt. */
  readonly startContinuation: (sessionId: string, runId: string) => Promise<void>;
  readonly newRunId: () => string;
  /** Whether `runId` is live, for taking over a stale continuation key. */
  readonly isRunLive: (sessionId: string, incarnation: string, runId: string) => Promise<boolean>;
  /** Whether the bureau is shutting down: nothing is started, and nothing counts as a failure. */
  readonly isClosed: () => boolean;
  readonly diagnose: (message: string, cause?: unknown) => void;
}

export interface SessionInputContinuation {
  /**
   * Records that the session may have open input, BEFORE the input is admitted,
   * so admitted input is never missing from the sweep's index.
   */
  markOpen(sessionId: string): Promise<void>;
  /**
   * Makes sure a session with open input has a live run. With `ended`, the caller
   * is the run that just ended and has already made itself not live. Without it
   * the caller is the submit side (after its admission committed) or the sweep.
   */
  reconcile(
    sessionId: string,
    ended?: { readonly runId: string; readonly outcome: SessionInputRunOutcome },
  ): Promise<void>;
  /**
   * The continuation key's bookkeeping for a run that ended, with nothing started
   * and nothing else read: a continuation run that ended is no longer in flight.
   */
  settleEnded(
    sessionId: string,
    ended: { readonly runId: string; readonly outcome: SessionInputRunOutcome },
  ): Promise<void>;
  /** Reconciles every session that has a marker. */
  sweep(): Promise<void>;
}

function parseMarker(raw: string | null): MarkerRecord | undefined {
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<MarkerRecord>;
  if (typeof record.sessionId !== 'string' || typeof record.version !== 'number') return undefined;
  return { sessionId: record.sessionId, version: record.version };
}

function parseContinuation(raw: string | null): ContinuationRecord | undefined {
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<ContinuationRecord>;
  if (
    typeof record.runId !== 'string' ||
    typeof record.startedAtMs !== 'number' ||
    typeof record.failures !== 'number'
  ) {
    return undefined;
  }
  return { runId: record.runId, startedAtMs: record.startedAtMs, failures: record.failures };
}

/**
 * Applies `action` to every open receipt of a mailbox, in bounded batches, until
 * none is left or a batch makes no progress. A backlog deeper than one batch is
 * handled in full; `list` cannot be paged, so each batch is re-listed after the
 * last one's commands left the open states.
 */
export async function forEachOpenReceipt(
  mailbox: Mailbox,
  action: (commandId: string) => Promise<unknown>,
): Promise<void> {
  const handled = new Set<string>();
  for (;;) {
    const batch = await mailbox.list({
      states: OPEN_SESSION_INPUT_STATES,
      limit: SESSION_INPUT_BACKLOG_BATCH,
    });
    const fresh = batch.filter((receipt) => !handled.has(receipt.commandId));
    if (fresh.length === 0) return;
    for (const receipt of fresh) {
      handled.add(receipt.commandId);
      await action(receipt.commandId);
    }
  }
}

export function createSessionInputContinuation(
  dependencies: SessionInputContinuationDependencies,
): SessionInputContinuation {
  const { kv, deliveryStore, diagnose } = dependencies;

  async function writeContinuation(
    sessionId: string,
    expectedRaw: string | null,
    next: ContinuationRecord | undefined,
  ): Promise<boolean> {
    const key = continuationKey(sessionId);
    return kv.conditionalBatch(
      [{ key, expectedValue: expectedRaw }],
      [
        next === undefined
          ? { type: 'delete', key }
          : { type: 'set', key, value: JSON.stringify(next) },
      ],
    );
  }

  async function promotedBy(sessionId: string, runId: string): Promise<boolean> {
    const records = await deliveryStore.read(sessionId);
    return Object.values(records).some(
      (record) => record.runId === runId && record.promotion !== undefined,
    );
  }

  async function rejectOpenInput(mailbox: Mailbox): Promise<void> {
    for (let rejected = 0; rejected < 100_000; rejected += 1) {
      let result = await mailbox.claim();
      if (result.status === 'held') {
        await mailbox.waitForAvailable({
          timeoutMs: 1_100,
          pollIntervalMs: 10,
          signal: AbortSignal.timeout(1_200),
        });
        result = await mailbox.claim();
      }
      if (result.status !== 'claimed') return;
      await mailbox.reject({
        commandId: result.claim.receipt.commandId,
        attemptToken: result.claim.attemptToken,
        failure: { reason: 'application', message: 'no run could consume this input' },
        retry: false,
      });
    }
  }

  async function bumpMarker(sessionId: string): Promise<void> {
    const key = markerKey(sessionId);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      const next: MarkerRecord = {
        sessionId,
        version: (parseMarker(raw)?.version ?? 0) + 1,
      };
      if (
        await kv.conditionalBatch(
          [{ key, expectedValue: raw }],
          [{ type: 'set', key, value: JSON.stringify(next) }],
        )
      ) {
        return;
      }
    }
    throw new Error(`The open-input marker of session "${sessionId}" kept changing.`);
  }

  /**
   * Removes the marker only if the mailbox has no open input and the marker has
   * not changed since it was read. Losing the delete means the session changed
   * under it, so it decides again from what it reads next.
   */
  async function removeMarkerIfIdle(sessionId: string, mailbox: Mailbox): Promise<boolean> {
    const key = markerKey(sessionId);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      if (raw === null) return true;
      const open = await mailbox.list({ states: OPEN_SESSION_INPUT_STATES, limit: 1 });
      if (open.length > 0) return false;
      if (await kv.conditionalBatch([{ key, expectedValue: raw }], [{ type: 'delete', key }])) {
        return true;
      }
    }
    return false;
  }

  /** The continuation key after a run that may have been the recorded continuation ended. */
  async function settleContinuationEnd(
    sessionId: string,
    ended: { readonly runId: string; readonly outcome: SessionInputRunOutcome },
  ): Promise<void> {
    const key = continuationKey(sessionId);
    const raw = await kv.get(key);
    const record = parseContinuation(raw);
    // Only a continuation still in flight is settled, and only once.
    if (
      record === undefined ||
      record.runId !== ended.runId ||
      record.startedAtMs === SETTLED_STARTED_AT_MS
    ) {
      return;
    }
    let failures = record.failures;
    if (await promotedBy(sessionId, ended.runId)) {
      failures = 0;
    } else if (ended.outcome === 'error' || ended.outcome === 'completed') {
      // It consumed none of the input: an error, or a run that ended with nothing
      // answered. An abort or a stop is not the continuation's failure.
      failures += 1;
    }
    const settled =
      failures === 0
        ? undefined
        : { runId: ended.runId, startedAtMs: SETTLED_STARTED_AT_MS, failures };
    // Lost to another reconcile that settled it first: theirs stands.
    await writeContinuation(sessionId, raw, settled);
  }

  const continuation: SessionInputContinuation = {
    markOpen: bumpMarker,

    settleEnded: settleContinuationEnd,

    async reconcile(sessionId, ended) {
      const incarnation = await dependencies.incarnationOf(sessionId);
      const mailbox = dependencies.mailboxOf(sessionId);
      if (incarnation === undefined) {
        if (mailbox !== undefined) await removeMarkerIfIdle(sessionId, mailbox);
        return;
      }
      if (mailbox === undefined || dependencies.isClosed()) return;

      if (ended !== undefined) {
        await settleContinuationEnd(sessionId, ended);
        // The ending run has already made itself not live, so reading the marker
        // now, and the mailbox after it, sees every input whose admission was
        // committed before that write (see the module doc). A session with no
        // marker has had no input admitted since.
        const marker = parseMarker(await kv.get(markerKey(sessionId)));
        const settled = parseContinuation(await kv.get(continuationKey(sessionId)));
        if (marker === undefined && settled === undefined) return;
      }

      const live = await dependencies.liveRunIds(sessionId, incarnation, ended?.runId);
      if (live.length > 0) return;
      const open = await mailbox.list({ states: OPEN_SESSION_INPUT_STATES, limit: 1 });
      if (open.length === 0) {
        // Nothing is waiting, so a failure count left behind is moot.
        const idleKey = continuationKey(sessionId);
        const idleRaw = await kv.get(idleKey);
        if (idleRaw !== null) await writeContinuation(sessionId, idleRaw, undefined);
        await removeMarkerIfIdle(sessionId, mailbox);
        return;
      }
      // Open input exists: it must be findable by the sweep whatever happens next.
      await bumpMarker(sessionId);

      const key = continuationKey(sessionId);
      const raw = await kv.get(key);
      const record = parseContinuation(raw);
      let failures = record?.failures ?? 0;
      if (record !== undefined && record.startedAtMs !== SETTLED_STARTED_AT_MS) {
        // Another reconcile started a continuation. Leave it be while it may still be starting or live.
        const age = dependencies.nowMs() - record.startedAtMs;
        const recordLive = await dependencies.isRunLive(sessionId, incarnation, record.runId);
        if (recordLive || age < SESSION_INPUT_CONTINUATION_START_WINDOW_MS) return;
        // A stale record: a continuation that never became a run counts as a failure.
        failures += 1;
      }
      if (failures >= SESSION_INPUT_CONTINUATION_FAILURE_LIMIT) {
        await rejectOpenInput(mailbox);
        await writeContinuation(sessionId, raw, undefined);
        await removeMarkerIfIdle(sessionId, mailbox);
        return;
      }

      const runId = dependencies.newRunId();
      const claimed: ContinuationRecord = {
        runId,
        startedAtMs: dependencies.nowMs(),
        failures,
      };
      // Another reconcile won the race; one continuation is all the session needs.
      if (!(await writeContinuation(sessionId, raw, claimed))) return;
      try {
        await dependencies.startContinuation(sessionId, runId);
      } catch (error) {
        // Shutting down is not a failure of the continuation.
        if (dependencies.isClosed()) {
          await writeContinuation(sessionId, JSON.stringify(claimed), undefined);
          return;
        }
        diagnose(
          `Could not start a continuation run for session "${sessionId}" to answer its pending input.`,
          error,
        );
        // Counted against the record this reconcile wrote, so a newer reconcile's
        // settlement is not overwritten.
        await writeContinuation(sessionId, JSON.stringify(claimed), {
          runId,
          startedAtMs: SETTLED_STARTED_AT_MS,
          failures: failures + 1,
        });
      }
    },

    async sweep() {
      for (const key of await kv.list(MARKER_PREFIX)) {
        try {
          const marker = parseMarker(await kv.get(key));
          if (marker === undefined) continue;
          await continuation.reconcile(marker.sessionId);
        } catch (error) {
          diagnose(`Could not reconcile the pending input behind marker "${key}".`, error);
        }
      }
    },
  };
  return continuation;
}
