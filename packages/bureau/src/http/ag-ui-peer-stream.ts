/**
 * The AG-UI stream of a run another Bureau process holds (COR-1580).
 *
 * Several Bureau processes can share one durable store, and a request can reach one that does not
 * hold the run it names. Such a process has none of the run's live frames, its liveness, or the
 * reviews its holder lists, so it streams what durable state says instead: the conversation as a
 * `MESSAGES_SNAPSHOT`, the durable run's own status as the `STATE_SNAPSHOT`, and then the run's
 * outcome. It streams no step, tool, or text-delta event.
 *
 * The outcome is the earlier of two readings. The run's durable event history carries its
 * terminal record (`run.completed`, `run.error`, `run.aborted`), and a `run.tripwire` before it,
 * which labels the ending as the projection does. The durable run's own status, read once
 * `waitForDurableRun` settles, covers a run that records no terminal event: one cancelled or
 * timed out by another process, whose holder sees the foreign terminal commit and writes nothing.
 *
 * The run's terminal record and the session's terminal save are not ordered, so once the outcome
 * is known the stream waits for the session to show the run settled, re-reading it on each durable
 * `session.saved`, for at most {@link PEER_SESSION_SETTLE_GRACE_MS} on the mount's clock. It then
 * sends the conversation as it stands, and the terminal event.
 *
 * A run parked on a human wait ends the stream with its interrupt, read from
 * `Bureau.pendingHumanWaitsOfRun`. A run that settled with a tool approval no process restored is
 * replayed from the session's `pendingApprovalOverrides` and conversation, and ends with the
 * approval's interrupt under its review id.
 *
 * @module ag-ui-peer-stream
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { AgentSession } from '@lostgradient/operative';
import type { WorkflowState } from '@lostgradient/weft';
import { type Event, EventType, type Interrupt } from '@ag-ui/core';

import { isDurableRunUnsettled } from '../create-bureau.ts';
import { ownerOrLocal } from '../owner-of-record.ts';
import { resolvePersistedRunOwningPrincipal } from '../session-authority.ts';
import type {
  Bureau,
  PendingHumanWaitReview,
  PendingReview,
  PendingToolApprovalReview,
} from '../types.ts';
import { toInterrupt } from './ag-ui-interrupts.ts';
import { snapshotMessages } from './ag-ui-messages.ts';
import { errorOf, type NativeTerminal, RECORDED, usageOf } from './ag-ui-projection.ts';
import { readSessionOwnedBy } from './ag-ui-session-owner.ts';
import { type AgUiErrorCode, type EventStamp, stamp } from './ag-ui-vocabulary.ts';

/**
 * How long a peer's stream waits, once it knows the run's outcome, for the session to record the
 * run's end before it sends the conversation as it stands. Measured on the mount's clock.
 */
export const PEER_SESSION_SETTLE_GRACE_MS = 2000;

/** What a peer's stream reads from the Bureau. */
export type PeerStreamBureau = Pick<
  Bureau,
  | 'getSession'
  | 'getDurableRun'
  | 'eventHistory'
  | 'pendingHumanWaitsOfRun'
  | 'waitForDurableRun'
  | 'subscribeEventHistory'
>;

/** The terminal a peer learned, and whether it came from the run's durable history. */
type PeerTerminal = NativeTerminal & { readonly cursor?: string | undefined };

/** What a peer's stream needs from the stream that opened it. */
export type PeerStreamContext = {
  readonly bureau: PeerStreamBureau;
  readonly timers: RuntimeServices['timers'];
  readonly stampContext: EventStamp;
  readonly threadId: string;
  /** The `runId` the AG-UI run carries. */
  readonly runId: string;
  readonly nativeRunId: string;
  readonly owner: string;
  /** The interrupts a resume just answered, which a peer may still read as pending. */
  readonly answered: ReadonlySet<string>;
  readonly answerRows: ReadonlyArray<{ readonly id: string; readonly content: string }>;
  readonly preludeEvents: () => Event[];
  readonly replayCall: (
    history: AgentSession['conversationHistory'] | undefined,
    callId: string,
  ) => Event[];
  readonly writeEvents: (events: ReadonlyArray<Event>) => void;
  readonly isEnded: () => boolean;
  /** Marks the opening written: what follows is the live tail. */
  readonly markOpened: () => void;
  /** Runs `cleanup` when the stream ends, however it ends. */
  readonly onDispose: (cleanup: () => void) => void;
  readonly interruptNow: (interrupts: Interrupt[]) => void;
  readonly fail: (code: AgUiErrorCode, message: string) => void;
  /** Ends the stream with `last`, its durable cursor when it has one. */
  readonly finish: (last: Event, cursor?: string) => void;
};

const STATUS_TERMINAL: Readonly<Record<string, NativeTerminal['outcome']>> = {
  completed: 'completed',
  cancelled: 'aborted',
  failed: 'error',
  'timed-out': 'error',
};

/**
 * How a settled durable run ended, from its durable state alone: `undefined` while it is unsettled.
 * A Bureau run that ends in an error or an abort still completes its workflow, so a `completed`
 * run is read by the finish reason its result records.
 */
export function settledOutcomeOf(state: WorkflowState): NativeTerminal['outcome'] | undefined {
  const outcome = STATUS_TERMINAL[state.status];
  if (outcome !== 'completed') return outcome;
  const result: unknown = state.result;
  const finishReason =
    typeof result === 'object' && result !== null
      ? (result as { finishReason?: unknown }).finishReason
      : undefined;
  if (finishReason === 'error') return 'error';
  if (finishReason === 'aborted') return 'aborted';
  return 'completed';
}

const HISTORY_TERMINAL: Readonly<Record<string, NativeTerminal['outcome']>> = {
  [RECORDED.runCompleted]: 'completed',
  [RECORDED.runError]: 'error',
  [RECORDED.runAborted]: 'aborted',
};

/** The terminal a settled durable run stands for, when the run recorded none of its own. */
function terminalOfStatus(runId: string, state: WorkflowState): PeerTerminal | undefined {
  const outcome = settledOutcomeOf(state);
  if (outcome === undefined) return undefined;
  return {
    outcome,
    detail:
      outcome === 'error'
        ? {
            error: {
              code: 'RUN_FAILED',
              message: `Run "${runId}" ended with status ${state.status}`,
            },
          }
        : undefined,
    tripwire: false,
  };
}

/** Resolves on the next `bump()` after it was asked for. */
class Changes {
  private waiters: Array<() => void> = [];
  next(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  bump(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * The tool approvals a settled run's session still holds for it, as reviews: the entries of
 * `pendingApprovalOverrides` whose resolution has not started and whose binding has not expired,
 * with the round the session recorded. The rule `listPendingReviews` restores them by.
 */
export function sessionApprovalsOf(
  session: AgentSession | undefined,
  runId: string,
  now: number,
): PendingToolApprovalReview[] {
  const metadata = session?.metadata;
  const overrides = metadata?.['pendingApprovalOverrides'];
  if (
    session === undefined ||
    typeof overrides !== 'object' ||
    overrides === null ||
    Array.isArray(overrides)
  ) {
    return [];
  }
  const started = new Set(
    Array.isArray(metadata?.['approvalResolutionStartedIds'])
      ? metadata['approvalResolutionStartedIds'].filter((id) => typeof id === 'string')
      : [],
  );
  const rounds = metadata?.['pendingApprovalRounds'];
  const reviews: PendingToolApprovalReview[] = [];
  for (const [id, value] of Object.entries(overrides)) {
    if (!id.startsWith(`approval:${runId}:`) || started.has(id)) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const approval = value as unknown as PendingToolApprovalReview['approval'];
    const expiresAt = approval.approvalBinding?.expiresAt;
    if (typeof expiresAt === 'number' && expiresAt <= now) continue;
    const round =
      typeof rounds === 'object' && rounds !== null && !Array.isArray(rounds)
        ? (rounds as Record<string, unknown>)[id]
        : undefined;
    reviews.push({
      kind: 'tool-approval',
      id,
      runId,
      sessionId: session.id,
      agentName: session.agentName,
      approval,
      requestedAt: now,
      ageMilliseconds: 0,
      status: 'pending',
      round: typeof round === 'number' && Number.isInteger(round) && round > 0 ? round : 0,
    });
  }
  return reviews;
}

/**
 * Streams a run this process does not hold, from durable state. `durable` is the run's durable
 * state as the stream found it on opening.
 */
export async function openPeerStream(
  context: PeerStreamContext,
  durable: WorkflowState,
  fence: string | undefined,
): Promise<void> {
  const { bureau, nativeRunId, stampContext } = context;
  const live = <TEvent extends Event>(event: TEvent): TEvent =>
    stamp(event, stampContext, { durable: false });
  const session = await readSessionOwnedBy(bureau, context.threadId, context.owner).catch(
    () => undefined,
  );
  // The route authorized the thread's owner. A session that is not that owner's, or that records
  // this run as another owner's, is not one this stream may show.
  const recordedOwner =
    session === undefined
      ? undefined
      : resolvePersistedRunOwningPrincipal(session.metadata, nativeRunId);
  if (
    session === undefined ||
    (recordedOwner !== undefined && ownerOrLocal(recordedOwner) !== context.owner)
  ) {
    context.fail('RUN_NOT_FOUND', `Run "${nativeRunId}" was not found`);
    return;
  }
  const conversation = session.conversationHistory;
  const settled = !isDurableRunUnsettled(durable.status);
  const waits = await humanWaitsOf(context);
  const approvals = settled ? sessionApprovalsOf(session, nativeRunId, stampContext.now()) : [];

  context.writeEvents([
    live({ type: EventType.RUN_STARTED, threadId: context.threadId, runId: context.runId }),
  ]);
  for (const row of context.answerRows) {
    if (conversation.ids.includes(row.id)) continue;
    context.writeEvents([
      live({ type: EventType.TEXT_MESSAGE_START, messageId: row.id, role: 'user' }),
      live({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: row.id, delta: row.content }),
      live({ type: EventType.TEXT_MESSAGE_END, messageId: row.id }),
    ]);
  }
  context.writeEvents([
    stamp(
      { type: EventType.MESSAGES_SNAPSHOT, messages: snapshotMessages(conversation) },
      stampContext,
      { durable: false, ...(fence === undefined ? {} : { cursor: fence }) },
    ),
    live({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        revision: 0,
        status: durable.status,
        pendingInterruptIds: [...waits, ...approvals].map((review) => review.id),
      },
    }),
  ]);
  context.writeEvents(context.preludeEvents());
  if (context.isEnded()) return;
  context.markOpened();

  if (waits.length > 0) {
    context.interruptNow(waits.map(toInterrupt));
    return;
  }
  if (approvals.length > 0) {
    endWithApprovals(context, conversation, approvals);
    return;
  }
  await tail(context, durable, settled);
}

/** The human waits the run is parked on, less the ones a resume just answered. */
async function humanWaitsOf(context: PeerStreamContext): Promise<PendingHumanWaitReview[]> {
  const waits = await context.bureau
    .pendingHumanWaitsOfRun(context.nativeRunId)
    .catch((): PendingHumanWaitReview[] => []);
  return waits.filter((review) => !context.answered.has(review.id));
}

function endWithApprovals(
  context: PeerStreamContext,
  conversation: AgentSession['conversationHistory'],
  approvals: ReadonlyArray<PendingReview>,
): void {
  for (const review of approvals) {
    if (review.kind === 'tool-approval') {
      context.writeEvents(context.replayCall(conversation, review.approval.callId));
    }
  }
  context.interruptNow(approvals.map(toInterrupt));
}

/**
 * Follows the run to its outcome: the earlier of its history's terminal event and its settled
 * durable status, unless it parks on a human wait first.
 */
async function tail(
  context: PeerStreamContext,
  durable: WorkflowState,
  settled: boolean,
): Promise<void> {
  const { bureau, nativeRunId } = context;
  const sessionSaves = new Changes();
  const sessionSubscription = bureau.subscribeEventHistory(
    { kind: 'session', id: context.threadId },
    (event) => {
      if (event.kind === 'session.saved') sessionSaves.bump();
    },
  );
  context.onDispose(() => sessionSubscription.unsubscribe());

  type Ending =
    | { readonly kind: 'terminal'; readonly terminal: PeerTerminal }
    | { readonly kind: 'parked'; readonly waits: PendingHumanWaitReview[] }
    | undefined;
  let decided = false;
  const ending = await new Promise<Ending>((resolve) => {
    const decide = (value: Ending): void => {
      decided = true;
      resolve(value);
    };
    context.onDispose(() => decide(undefined));
    let tripwire = false;
    const runSubscription = bureau.subscribeEventHistory(
      { kind: 'run', id: nativeRunId },
      (event) => {
        if (event.kind === RECORDED.runTripwire) tripwire = true;
        const outcome = HISTORY_TERMINAL[event.kind];
        if (outcome === undefined) return;
        decide({
          kind: 'terminal',
          terminal: { outcome, detail: event.payload, tripwire, cursor: event.cursor },
        });
      },
    );
    context.onDispose(() => runSubscription.unsubscribe());

    const fromStatus = (state: WorkflowState | null | undefined): void => {
      const terminal =
        state === undefined || state === null ? undefined : terminalOfStatus(nativeRunId, state);
      if (terminal !== undefined) decide({ kind: 'terminal', terminal });
    };
    if (settled) fromStatus(durable);
    else {
      // Under `durableBackgroundTasks: 'manual'` the wait is refused, and the history's terminal
      // and the stream's deadline are what end the stream.
      bureau.waitForDurableRun(nativeRunId).then(fromStatus, () => undefined);
    }

    // A run that parks while the stream follows it saves its session; each save is a reason to
    // look again.
    void (async () => {
      for (;;) {
        const next = sessionSaves.next();
        const waits = await humanWaitsOf(context);
        if (decided) return;
        if (waits.length > 0) {
          decide({ kind: 'parked', waits });
          return;
        }
        await next;
        if (decided) return;
      }
    })();
  });
  if (ending === undefined || context.isEnded()) return;
  if (ending.kind === 'parked') {
    context.interruptNow(ending.waits.map(toInterrupt));
    return;
  }
  await finishPeer(context, ending.terminal, sessionSaves);
}

/** Whether the session has recorded the run's end. */
function sessionSettledFor(session: AgentSession | undefined, runId: string): boolean {
  return (
    session !== undefined &&
    session.metadata['lastRunId'] === runId &&
    session.metadata['lastRunStatus'] !== 'running'
  );
}

/**
 * The session once it shows the run settled, re-read on each durable `session.saved`, or as it
 * stands after {@link PEER_SESSION_SETTLE_GRACE_MS}.
 */
async function settledSession(
  context: PeerStreamContext,
  sessionSaves: Changes,
): Promise<AgentSession | undefined> {
  let graceOver = false;
  let endGrace!: () => void;
  const grace = new Promise<void>((resolve) => {
    endGrace = resolve;
  });
  const handle = context.timers.setTimeout(() => {
    graceOver = true;
    endGrace();
  }, PEER_SESSION_SETTLE_GRACE_MS);
  // Also lets the wait below go when the stream ends first.
  const clear = (): void => {
    context.timers.clearTimeout(handle);
    endGrace();
  };
  context.onDispose(clear);
  try {
    for (;;) {
      const next = sessionSaves.next();
      const session = await readSessionOwnedBy(
        context.bureau,
        context.threadId,
        context.owner,
      ).catch(() => undefined);
      if (sessionSettledFor(session, context.nativeRunId) || graceOver || context.isEnded()) {
        return session;
      }
      await Promise.race([next, grace]);
    }
  } finally {
    clear();
  }
}

/** The run's last terminal record and whether a tripwire preceded it, from its durable history. */
async function historyTerminal(
  bureau: PeerStreamBureau,
  runId: string,
): Promise<PeerTerminal | undefined> {
  let since: string | undefined;
  let tripwire = false;
  let terminal: PeerTerminal | undefined;
  for (;;) {
    const page = await bureau.eventHistory(
      { kind: 'run', id: runId },
      since === undefined ? {} : { since },
    );
    if (!('events' in page)) return terminal;
    for (const event of page.events) {
      if (event.kind === RECORDED.runTripwire) tripwire = true;
      const outcome = HISTORY_TERMINAL[event.kind];
      if (outcome !== undefined) {
        terminal = { outcome, detail: event.payload, tripwire, cursor: event.cursor };
      }
    }
    if (!page.hasMore || page.nextCursor === undefined) return terminal;
    since = page.nextCursor;
  }
}

/**
 * Ends the stream with the run's outcome: the session as it stands once it shows the run settled
 * (or the grace is over), then the terminal event. A terminal the run's history recorded is
 * preferred to one read from its status, because it carries the record's cursor and its tripwire.
 */
async function finishPeer(
  context: PeerStreamContext,
  learned: PeerTerminal,
  sessionSaves: Changes,
): Promise<void> {
  const { stampContext } = context;
  const session = await settledSession(context, sessionSaves);
  if (context.isEnded()) return;
  const recorded = await historyTerminal(context.bureau, context.nativeRunId).catch(
    () => undefined,
  );
  if (context.isEnded()) return;
  const terminal = recorded ?? learned;
  const label = {
    durable: terminal.cursor !== undefined,
    ...(terminal.cursor === undefined ? {} : { cursor: terminal.cursor }),
    ...(terminal.tripwire ? { tripwire: true as const } : {}),
  };
  if (session === undefined) {
    // The thread could not be read back, so what the run left in it cannot be told.
    context.finish(
      stamp(
        {
          type: EventType.RUN_ERROR,
          code: 'RUN_FAILED',
          message:
            'The run ended, but the thread could not be read. Reload to see the thread as it is.',
        },
        stampContext,
        label,
      ),
      terminal.cursor,
    );
    return;
  }
  context.writeEvents([
    stamp(
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: snapshotMessages(session.conversationHistory),
      },
      stampContext,
      { durable: false },
    ),
  ]);
  if (context.isEnded()) return;
  context.finish(terminalEvent(context, terminal, session, label), terminal.cursor);
}

function terminalEvent(
  context: PeerStreamContext,
  terminal: PeerTerminal,
  session: AgentSession,
  label: { readonly durable: boolean; readonly cursor?: string; readonly tripwire?: true },
): Event {
  const { threadId, runId, stampContext } = context;
  if (terminal.outcome === 'error') {
    const { code, message } = errorOf(terminal.detail);
    return stamp({ type: EventType.RUN_ERROR, code, message }, stampContext, label);
  }
  if (terminal.outcome === 'aborted') {
    return stamp(
      { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'cancelled' } },
      stampContext,
      label,
    );
  }
  // A run that settled with an approval gated: the interrupt is what is left of it.
  const approvals = sessionApprovalsOf(session, context.nativeRunId, stampContext.now());
  for (const review of approvals) {
    context.writeEvents(context.replayCall(session.conversationHistory, review.approval.callId));
  }
  return stamp(
    {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      outcome:
        approvals.length > 0
          ? { type: 'interrupt', interrupts: approvals.map(toInterrupt) }
          : { type: 'success' },
      usage: usageOf(terminal.detail),
    },
    stampContext,
    label,
  );
}
