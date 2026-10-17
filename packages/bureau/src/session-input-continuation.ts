import type { SessionInputDeliveryStore } from '@lostgradient/operative';
import type { ConditionalTextValueStore, Mailbox } from '@lostgradient/weft';
import { encodeStorageKeyComponent } from '@lostgradient/weft';

/**
 * COR-1476 — the invariant that a session with open input always has a live run,
 * so an input `submitSessionInput` called `admitted` is always answered.
 *
 * A run drains the session's input at each of its step boundaries and once more
 * when its last step would end it. Input that arrives after that final drain, or
 * that a run's budget left over, would otherwise wait for a run nobody has
 * started. When a run ends, {@link SessionInputContinuation.reconcile} looks at
 * the session: if no run is live and the mailbox still has open commands, it
 * starts a CONTINUATION run, with no prompt of its own, whose first step boundary
 * delivers the backlog in admission order. `submitSessionInput` runs the same
 * reconcile after admitting, so an input admitted just as the last run ends is
 * not lost to the race, and a backstop set of sessions that have had input, swept
 * by durable maintenance and boot recovery, repairs a reconcile that never ran.
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
 * failure, as does one that cannot be started. After two in a row the open
 * commands are rejected, so the input's receipt reads `failed` rather than
 * `accepted` forever. A continuation that is aborted does not count.
 */

/** How long a continuation may be starting before another reconcile may take it over. */
export const SESSION_INPUT_CONTINUATION_START_WINDOW_MS = 60_000;

/** Consecutive failed continuations after which the open input is rejected. */
export const SESSION_INPUT_CONTINUATION_FAILURE_LIMIT = 2;

const OPEN_STATES = ['accepted', 'available', 'claimed', 'cancellation-requested'] as const;
const CAS_ATTEMPTS = 20;

const openSessionsKey = 'session-input-open-sessions:v1';
const continuationKey = (sessionId: string) =>
  `session-input-continuation:v1:${encodeStorageKeyComponent(sessionId)}`;

interface ContinuationRecord {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly failures: number;
}

export type SessionInputRunOutcome = 'completed' | 'error' | 'aborted';

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
  readonly diagnose: (message: string, cause?: unknown) => void;
}

export interface SessionInputContinuation {
  /** Records that the session has had input, so the backstop sweep will find it. */
  noteOpen(sessionId: string): Promise<void>;
  /**
   * Makes sure a session with open input has a live run. `ended` names the run
   * that just ended, when one did.
   */
  reconcile(
    sessionId: string,
    ended?: { readonly runId: string; readonly outcome: SessionInputRunOutcome },
  ): Promise<void>;
  /** Reconciles every session the backstop set lists. */
  sweep(): Promise<void>;
}

function parseOpenSessions(raw: string | null): string[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : [];
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

export function createSessionInputContinuation(
  dependencies: SessionInputContinuationDependencies,
): SessionInputContinuation {
  const { kv, deliveryStore, diagnose } = dependencies;

  async function changeOpenSessions(change: (sessions: string[]) => string[] | undefined) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(openSessionsKey);
      const next = change(parseOpenSessions(raw));
      if (next === undefined) return;
      if (
        await kv.conditionalBatch(
          [{ key: openSessionsKey, expectedValue: raw }],
          [{ type: 'set', key: openSessionsKey, value: JSON.stringify(next) }],
        )
      ) {
        return;
      }
    }
    throw new Error('The open-sessions set kept changing.');
  }

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
    for (let rejected = 0; rejected < 1000; rejected += 1) {
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

  const continuation: SessionInputContinuation = {
    noteOpen(sessionId) {
      return changeOpenSessions((sessions) =>
        sessions.includes(sessionId) ? undefined : [...sessions, sessionId],
      );
    },

    async reconcile(sessionId, ended) {
      const forget = () =>
        changeOpenSessions((sessions) =>
          sessions.includes(sessionId)
            ? sessions.filter((entry) => entry !== sessionId)
            : undefined,
        );
      const incarnation = await dependencies.incarnationOf(sessionId);
      if (incarnation === undefined) {
        await forget();
        return;
      }
      const mailbox = dependencies.mailboxOf(sessionId);
      if (mailbox === undefined) return;

      // A continuation that just ended: settle what it says about the loop guard.
      const key = continuationKey(sessionId);
      let raw = await kv.get(key);
      let record = parseContinuation(raw);
      if (ended !== undefined && record?.runId === ended.runId) {
        let failures = record.failures;
        if (ended.outcome === 'error' && !(await promotedBy(sessionId, ended.runId))) {
          failures += 1;
        } else if (ended.outcome === 'completed') {
          failures = 0;
        }
        const settled =
          failures === 0 ? undefined : { runId: ended.runId, startedAtMs: 0, failures };
        if (!(await writeContinuation(sessionId, raw, settled))) {
          // Another reconcile settled it first.
          raw = await kv.get(key);
        } else {
          raw = settled === undefined ? null : JSON.stringify(settled);
        }
        record = parseContinuation(raw);
      }

      // A session that has never had input and has no continuation to settle owes
      // nothing, which is every session on the common path.
      const listed = parseOpenSessions(await kv.get(openSessionsKey)).includes(sessionId);
      if (!listed && record === undefined) return;

      const live = await dependencies.liveRunIds(sessionId, incarnation, ended?.runId);
      if (live.length > 0) return;
      const open = await mailbox.list({ states: OPEN_STATES, limit: 1 });
      if (open.length === 0) {
        if (record !== undefined && record.failures === 0)
          await writeContinuation(sessionId, raw, undefined);
        await forget();
        return;
      }

      let failures = record?.failures ?? 0;
      if (record !== undefined && record.startedAtMs !== 0) {
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
        await forget();
        return;
      }

      const runId = dependencies.newRunId();
      const claimed = await writeContinuation(sessionId, raw, {
        runId,
        startedAtMs: dependencies.nowMs(),
        failures,
      });
      // Another reconcile won the race; one continuation is all the session needs.
      if (!claimed) return;
      try {
        await dependencies.startContinuation(sessionId, runId);
      } catch (error) {
        diagnose(
          `Could not start a continuation run for session "${sessionId}" to answer its pending input.`,
          error,
        );
        // The start failed: leave the key stale, with the failure counted, for the backstop.
        const failed = JSON.stringify({ runId, startedAtMs: 0, failures: failures + 1 });
        await kv.set(key, failed);
      }
    },

    async sweep() {
      const sessions = parseOpenSessions(await kv.get(openSessionsKey));
      for (const sessionId of sessions) {
        try {
          await continuation.reconcile(sessionId);
        } catch (error) {
          diagnose(`Could not reconcile the pending input of session "${sessionId}".`, error);
        }
      }
    },
  };
  return continuation;
}
