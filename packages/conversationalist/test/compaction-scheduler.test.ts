/**
 * COR-808 — optimistic background compaction.
 *
 * A `CompactionScheduler` prepares a compaction candidate outside the
 * caller's critical path and publishes it only through
 * `Conversation.compact()`, the COR-810 compare-and-swap on the controller
 * revision. Every test drives the schedule adapter by hand and gates the
 * summarizer, so each race below is deterministic: the write lands after
 * the candidate's base revision is captured and before the summary returns.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { Conversation } from '../src/history';
import {
  createCompactionScheduler,
  createConversationHistory,
  type CompactionScheduleAdapter,
  type CompactionScheduler,
  type CompactionSchedulerPhase,
  type CompactionSchedulerState,
  type ConversationEvent,
  type Summarizer,
} from '../src/index';

type Gate = { readonly opened: Promise<void>; readonly release: () => void };

function createGate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

/**
 * A summarizer whose every call waits on the currently armed gate. It
 * ignores its abort signal on purpose: a late summary must still be unable
 * to publish, whatever the summarizer does with cancellation.
 */
function createGatedSummarizer() {
  let gate = createGate();
  const signals: (AbortSignal | undefined)[] = [];
  let active = 0;
  let maximumActive = 0;
  const summarizer: Summarizer = async (messages, options) => {
    signals.push(options?.signal);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await gate.opened;
      return `Summary of ${messages.length} messages`;
    } finally {
      active -= 1;
    }
  };
  return {
    summarizer,
    signals,
    get maximumActive() {
      return maximumActive;
    },
    /** Opens the gate for the candidate that is running now. */
    release(): void {
      gate.release();
    },
    /** Closes a fresh gate for the next candidate. */
    arm(): void {
      gate = createGate();
    },
  };
}

type QueuedTask = { readonly task: () => void; cancelled: boolean };

/** An adapter the test fires by hand, so "when does it run" is never a timing guess. */
function createManualSchedule() {
  const queue: QueuedTask[] = [];
  let scheduled = 0;
  const adapter: CompactionScheduleAdapter = {
    schedule(task) {
      scheduled += 1;
      const entry: QueuedTask = { task, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return {
    adapter,
    get scheduled() {
      return scheduled;
    },
    get queued() {
      return queue.filter((entry) => !entry.cancelled).length;
    },
    get cancelled() {
      return queue.filter((entry) => entry.cancelled).length;
    },
    /**
     * Runs the oldest queued task. With `ignoreCancel`, runs it even if it
     * was cancelled — an adapter whose cancel lost a race with the timer.
     */
    fire(options: { ignoreCancel?: boolean } = {}): void {
      const entry = queue.shift();
      if (!entry) throw new Error('no task is queued');
      if (entry.cancelled && !options.ignoreCancel) return;
      entry.task();
    },
  };
}

function conversationWithHistory(): Conversation {
  const conversation = new Conversation(createConversationHistory({ id: 'background' }));
  for (let index = 0; index < 6; index++) {
    conversation.appendUserMessage(`question ${index}`);
    conversation.appendAssistantMessage(`answer ${index}`);
  }
  return conversation;
}

function untilState(
  scheduler: CompactionScheduler,
  predicate: (state: CompactionSchedulerState) => boolean,
): Promise<CompactionSchedulerState> {
  if (predicate(scheduler.state)) return Promise.resolve(scheduler.state);
  return new Promise((resolve) => {
    const stop = scheduler.subscribe((state) => {
      if (!predicate(state)) return;
      stop();
      resolve(state);
    });
  });
}

function recordPhases(scheduler: CompactionScheduler): CompactionSchedulerPhase[] {
  const phases: CompactionSchedulerPhase[] = [];
  scheduler.subscribe((state) => phases.push(state.phase));
  return phases;
}

function recordEvents(conversation: Conversation, types: readonly string[]): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  for (const type of types) {
    conversation.addEventListener(type as 'change', (event) => events.push(event));
  }
  return events;
}

function hasPublishedSummary(conversation: Conversation): boolean {
  return conversation
    .getMessages({ includeHidden: true })
    .some((message) => message.metadata['compactionSummary'] === true);
}

describe('createCompactionScheduler', () => {
  it('prepares a candidate in a later window and publishes it only through compact()', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      compaction: { preserveRecentCount: 2 },
      schedule: schedule.adapter,
    });
    const phases = recordPhases(scheduler);
    const changes = recordEvents(conversation, ['change']);
    const baseRevision = conversation.revision;

    expect(scheduler.conversation).toBe(conversation);
    expect(scheduler.state).toMatchObject({ phase: 'idle', disposed: false, candidate: 0 });

    const outcome = scheduler.request();
    // Requesting never runs the summarizer inline: the caller's path stays clear.
    expect(scheduler.state.phase).toBe('pending');
    expect(gated.signals).toHaveLength(0);
    expect(schedule.queued).toBe(1);

    schedule.fire();
    expect(scheduler.state).toMatchObject({ phase: 'running', candidate: 1 });
    expect(conversation.revision).toBe(baseRevision);
    gated.release();

    const settled = await outcome;
    expect(settled.outcome).toBe('committed');
    expect(settled.candidates).toBe(1);
    if (settled.outcome !== 'committed') throw new Error('expected a commit');
    expect(settled.result.attempt).toMatchObject({ baseRevision, observedRevision: baseRevision });
    expect(conversation.revision).toBe(baseRevision + 1);
    expect(hasPublishedSummary(conversation)).toBe(true);

    // The only transition the scheduler caused is one compaction commit
    // against the base revision it captured.
    expect(changes.map((event) => event.action)).toEqual(['compaction.completed']);
    expect(changes[0]!.compaction?.baseRevision).toBe(baseRevision);

    expect(phases).toEqual(['pending', 'running', 'committed']);
    expect(scheduler.state).toMatchObject({
      phase: 'committed',
      candidate: 1,
      attempt: settled.result.attempt,
      counts: {
        requested: 1,
        candidates: 1,
        committed: 1,
        noOp: 0,
        discarded: 0,
        rescheduled: 0,
        deferred: 0,
        cancelled: 0,
        failed: 0,
      },
    });
  });

  it('keeps every streamed token when a stream outruns the summary, then commits a later candidate', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      compaction: { preserveRecentCount: 2 },
      schedule: schedule.adapter,
    });

    const outcome = scheduler.request();
    schedule.fire();
    // The stream opens after the candidate captured its base revision.
    const streamId = conversation.appendStreamingMessage('assistant');
    for (const partial of ['The', 'The answer', 'The answer is', 'The answer is 42']) {
      conversation.updateStreamingMessage(streamId, partial);
    }
    const streamed = JSON.stringify(conversation.current);
    gated.release();

    const rescheduled = await untilState(scheduler, (state) => state.counts.rescheduled === 1);
    expect(rescheduled).toMatchObject({ phase: 'pending', candidate: 1 });
    expect(rescheduled.counts.discarded).toBe(1);
    // The stale candidate wrote nothing: the streamed tokens are exactly as the stream left them.
    expect(JSON.stringify(conversation.current)).toBe(streamed);
    expect(conversation.getStreamingMessage()?.content).toBe('The answer is 42');
    expect(hasPublishedSummary(conversation)).toBe(false);
    // Rescheduled into a new window, not retried inline.
    expect(schedule.scheduled).toBe(2);

    // That window opens while the stream is still open, so no candidate starts.
    gated.arm();
    const summaryCalls = gated.signals.length;
    schedule.fire();
    expect(gated.signals).toHaveLength(summaryCalls);
    expect(scheduler.state).toMatchObject({ phase: 'pending', candidate: 1 });

    // Closing the stream is the durable boundary that queues the next window.
    conversation.finalizeStreamingMessage(streamId);
    expect(schedule.scheduled).toBe(3);
    schedule.fire();
    gated.release();

    const settled = await outcome;
    expect(settled).toMatchObject({ outcome: 'committed', candidates: 2 });
    expect(hasPublishedSummary(conversation)).toBe(true);
    const finalized = conversation.getMessages().at(-1);
    expect(finalized?.role).toBe('assistant');
    expect(finalized?.content).toBe('The answer is 42');
    expect(conversation.getStreamingMessage()).toBeUndefined();
    expect(scheduler.state.counts).toMatchObject({ candidates: 2, deferred: 1, rescheduled: 1 });
  });

  it('settles a request discarded after the bounded number of stale reschedules', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
      maxStaleRetries: 2,
    });
    const phases = recordPhases(scheduler);

    const outcome = scheduler.request();
    for (let candidate = 1; candidate <= 3; candidate++) {
      gated.arm();
      schedule.fire();
      conversation.appendUserMessage(`write racing candidate ${candidate}`);
      gated.release();
      await untilState(
        scheduler,
        (state) => state.counts.discarded === candidate && state.phase !== 'running',
      );
    }

    const settled = await outcome;
    expect(settled.outcome).toBe('discarded');
    expect(settled.candidates).toBe(3);
    if (settled.outcome !== 'discarded') throw new Error('expected a discard');
    expect(settled.result.reason).toBe('revision-conflict');
    // One window per candidate, and nothing queued after the bound.
    expect(schedule.scheduled).toBe(3);
    expect(schedule.queued).toBe(0);
    expect(hasPublishedSummary(conversation)).toBe(false);
    expect(
      conversation
        .getMessages()
        .map((message) => message.content)
        .filter((content) => typeof content === 'string' && content.startsWith('write racing')),
    ).toEqual(['write racing candidate 1', 'write racing candidate 2', 'write racing candidate 3']);
    expect(phases).toEqual([
      'pending',
      'running',
      'pending',
      'running',
      'pending',
      'running',
      'discarded',
    ]);
    expect(scheduler.state.counts).toMatchObject({
      requested: 1,
      candidates: 3,
      discarded: 3,
      rescheduled: 2,
      committed: 0,
    });
  });

  it('never reschedules a stale candidate when the bound is zero', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
      maxStaleRetries: 0,
    });

    const outcome = scheduler.request();
    schedule.fire();
    conversation.appendUserMessage('newer');
    gated.release();

    expect(await outcome).toMatchObject({ outcome: 'discarded', candidates: 1 });
    expect(schedule.scheduled).toBe(1);
  });

  it('rejects a stale-retry bound that is not a non-negative integer', () => {
    const conversation = conversationWithHistory();
    for (const maxStaleRetries of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createCompactionScheduler(conversation, {
          summarizer: async () => 'summary',
          maxStaleRetries,
        }),
      ).toThrow('maxStaleRetries');
    }
  });

  it('coalesces overlapping requests into one job with one summarizer at a time', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });

    const first = scheduler.request();
    const second = scheduler.request();
    expect(second).toBe(first);
    schedule.fire();
    const third = scheduler.request();
    expect(third).toBe(first);
    expect(schedule.scheduled).toBe(1);
    gated.release();

    const settled = await first;
    expect(settled.outcome).toBe('committed');
    expect(gated.maximumActive).toBe(1);
    expect(scheduler.state.counts.requested).toBe(1);

    // A settled job does not absorb the next request.
    const next = scheduler.request();
    expect(next).not.toBe(first);
    expect(scheduler.state).toMatchObject({ phase: 'pending', candidate: 0 });
    await scheduler.cancel();
    const withdrawn = await next;
    expect(withdrawn.outcome).toBe('cancelled');
  });

  it('settles no-op when nothing is eligible, and failed when the summarizer throws', async () => {
    const empty = new Conversation(createConversationHistory({ id: 'empty' }));
    const schedule = createManualSchedule();
    const noOp = createCompactionScheduler(empty, {
      summarizer: async () => 'unused',
      schedule: schedule.adapter,
    });
    const idle = noOp.request();
    schedule.fire();
    expect(await idle).toMatchObject({ outcome: 'no-op', candidates: 1 });
    expect(noOp.state).toMatchObject({ phase: 'no-op', counts: { noOp: 1 } });

    const conversation = conversationWithHistory();
    const before = JSON.stringify(conversation.current);
    const failure = new Error('summarizer unavailable');
    const failing = createCompactionScheduler(conversation, {
      summarizer: async () => {
        throw failure;
      },
      schedule: schedule.adapter,
    });
    const failed = failing.request();
    schedule.fire();
    const settled = await failed;
    expect(settled).toMatchObject({ outcome: 'failed', candidates: 1, error: failure });
    expect(failing.state).toMatchObject({ phase: 'failed', counts: { failed: 1 } });
    expect(JSON.stringify(conversation.current)).toBe(before);
  });

  it('settles failed when the schedule adapter cannot queue the task', async () => {
    const conversation = conversationWithHistory();
    const broken = new Error('scheduler unavailable');
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: async () => 'unused',
      schedule: {
        schedule() {
          throw broken;
        },
      },
    });

    expect(await scheduler.request()).toMatchObject({
      outcome: 'failed',
      candidates: 0,
      error: broken,
    });
    expect(scheduler.state.phase).toBe('failed');
  });

  it('stops notifying a listener once it unsubscribes', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: async () => 'summary',
      schedule: schedule.adapter,
    });
    const seen: CompactionSchedulerPhase[] = [];
    const stop = scheduler.subscribe((state) => seen.push(state.phase));

    const outcome = scheduler.request();
    stop();
    schedule.fire();
    await outcome;

    expect(seen).toEqual(['pending']);
  });
});

describe('cancelling background compaction', () => {
  it('cancel() withdraws queued work, and a timer that fires anyway does nothing', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });

    const outcome = scheduler.request();
    await scheduler.cancel();
    expect(await outcome).toEqual({ outcome: 'cancelled', reason: 'cancelled', candidates: 0 });
    expect(schedule.cancelled).toBe(1);

    schedule.fire({ ignoreCancel: true });
    expect(gated.signals).toHaveLength(0);
    expect(scheduler.state).toMatchObject({ phase: 'cancelled', counts: { cancelled: 1 } });

    // Cancelling with nothing queued is a no-op, and the scheduler stays usable.
    await scheduler.cancel();
    expect(scheduler.state.counts.cancelled).toBe(1);
    const again = scheduler.request();
    expect(scheduler.state.phase).toBe('pending');
    await scheduler.cancel();
    await again;
  });

  it('cancel() while running aborts the summarizer and a late summary cannot publish', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });
    const cancelledEvents = recordEvents(conversation, ['compaction.cancelled']);

    const outcome = scheduler.request();
    schedule.fire();
    const before = JSON.stringify(conversation.current);
    const revision = conversation.revision;
    let idle = false;
    const cancelling = scheduler.cancel().then(() => {
      idle = true;
      return undefined;
    });

    expect(gated.signals[0]?.aborted).toBe(true);
    // Still running: the summarizer has not returned, and the state says so.
    await Promise.resolve();
    expect(scheduler.state.phase).toBe('running');
    expect(idle).toBe(false);

    // The summarizer ignored its signal and returns late; nothing publishes.
    gated.release();
    await cancelling;
    expect(await outcome).toEqual({ outcome: 'cancelled', reason: 'cancelled', candidates: 1 });
    expect(scheduler.state).toMatchObject({ phase: 'cancelled', counts: { cancelled: 1 } });
    expect(cancelledEvents).toHaveLength(1);
    expect(conversation.revision).toBe(revision);
    expect(JSON.stringify(conversation.current)).toBe(before);
    expect(hasPublishedSummary(conversation)).toBe(false);
  });

  it('a new request waits for a cancelled candidate instead of running a second summary beside it', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      compaction: { preserveRecentCount: 2 },
      schedule: schedule.adapter,
    });
    const phases = recordPhases(scheduler);

    const abandoned = scheduler.request();
    schedule.fire();
    void scheduler.cancel();
    const next = scheduler.request();
    expect(next).not.toBe(abandoned);
    schedule.fire();

    // The abandoned summary is still running, so the next one has not started.
    expect(scheduler.state).toMatchObject({ phase: 'pending', candidate: 0 });
    const callsWhileAbandonedRuns = gated.signals.length;

    gated.release();
    expect(await abandoned).toMatchObject({ outcome: 'cancelled', reason: 'cancelled' });
    expect(await next).toMatchObject({ outcome: 'committed', candidates: 1 });
    expect(gated.signals.length).toBeGreaterThan(callsWhileAbandonedRuns);
    expect(gated.maximumActive).toBe(1);
    // The older request's settlement never overwrote the newer request's phase.
    expect(phases).toEqual(['pending', 'running', 'pending', 'pending', 'running', 'committed']);
    expect(scheduler.state.counts).toMatchObject({ requested: 2, cancelled: 1, committed: 1 });
  });

  it('a request signal (run cancellation) cancels queued and running work', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });

    const queuedRun = new AbortController();
    const queued = scheduler.request({ signal: queuedRun.signal });
    queuedRun.abort();
    expect(await queued).toEqual({ outcome: 'cancelled', reason: 'signal', candidates: 0 });
    expect(schedule.cancelled).toBe(1);

    const unrelated = new AbortController();
    const runningRun = new AbortController();
    const running = scheduler.request({ signal: unrelated.signal });
    // A second requester joins the same job; either requester's cancellation cancels it.
    expect(scheduler.request({ signal: runningRun.signal })).toBe(running);
    schedule.fire({ ignoreCancel: true });
    schedule.fire();
    expect(scheduler.state.phase).toBe('running');
    runningRun.abort();
    gated.release();
    expect(await running).toEqual({ outcome: 'cancelled', reason: 'signal', candidates: 1 });
    expect(hasPublishedSummary(conversation)).toBe(false);

    // A job that settled detaches from its requesters' signals.
    unrelated.abort();
    expect(scheduler.state.counts.cancelled).toBe(2);
  });

  it('attaches one abort listener per requester signal, however often it asks', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: async () => 'summary',
      schedule: schedule.adapter,
    });
    const run = new AbortController();
    const attach = spyOn(run.signal, 'addEventListener');
    const detach = spyOn(run.signal, 'removeEventListener');

    const outcome = scheduler.request({ signal: run.signal });
    // An agent run asks once per step while the window stays shut.
    scheduler.request({ signal: run.signal });
    scheduler.request({ signal: run.signal });
    expect(attach).toHaveBeenCalledTimes(1);

    run.abort();
    expect(await outcome).toMatchObject({ outcome: 'cancelled', reason: 'signal' });
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted request signal settles cancelled without queueing anything', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: async () => 'summary',
      schedule: schedule.adapter,
    });

    const settled = await scheduler.request({ signal: AbortSignal.abort() });

    expect(settled).toEqual({ outcome: 'cancelled', reason: 'signal', candidates: 0 });
    expect(schedule.scheduled).toBe(0);
    expect(scheduler.state.phase).toBe('idle');
  });

  it('dispose() cancels running work, refuses new requests, and waits for the attempt to settle', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });

    const outcome = scheduler.request();
    schedule.fire();
    const revision = conversation.revision;
    let disposed = false;
    const disposal = scheduler.dispose().then(() => {
      disposed = true;
      return undefined;
    });

    expect(scheduler.state.disposed).toBe(true);
    expect(await scheduler.request()).toEqual({
      outcome: 'cancelled',
      reason: 'disposed',
      candidates: 0,
    });
    // Disposal is quiescent: it resolves only once the abandoned attempt settles.
    await Promise.resolve();
    expect(disposed).toBe(false);
    gated.release();
    await disposal;
    expect(await outcome).toEqual({ outcome: 'cancelled', reason: 'disposed', candidates: 1 });
    expect(scheduler.state).toMatchObject({ phase: 'cancelled', disposed: true });
    expect(conversation.revision).toBe(revision);
    expect(hasPublishedSummary(conversation)).toBe(false);

    // Disposing twice is harmless.
    await scheduler[Symbol.asyncDispose]();
  });

  it('disposing the conversation cancels queued work and leaves the scheduler inert', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });

    const outcome = scheduler.request();
    await conversation.dispose();

    expect(await outcome).toEqual({ outcome: 'cancelled', reason: 'disposed', candidates: 0 });
    expect(schedule.cancelled).toBe(1);
    expect(scheduler.state.disposed).toBe(true);
    schedule.fire({ ignoreCancel: true });
    expect(gated.signals).toHaveLength(0);
  });

  it('closing the conversation mid-summary cancels the attempt without publishing', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });

    const outcome = scheduler.request();
    schedule.fire();
    const revision = conversation.revision;
    conversation.close();
    expect(scheduler.state.disposed).toBe(true);
    expect(gated.signals[0]?.aborted).toBe(true);

    gated.release();
    expect(await outcome).toEqual({ outcome: 'cancelled', reason: 'disposed', candidates: 1 });
    await scheduler.dispose();
    expect(conversation.revision).toBe(revision);
    expect(hasPublishedSummary(conversation)).toBe(false);
  });

  it('a scheduler created for a closed conversation is inert from the start', async () => {
    const conversation = conversationWithHistory();
    conversation.close();
    const schedule = createManualSchedule();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: async () => 'summary',
      schedule: schedule.adapter,
    });

    expect(scheduler.state.disposed).toBe(true);
    expect(await scheduler.request()).toMatchObject({ outcome: 'cancelled', reason: 'disposed' });
    expect(schedule.scheduled).toBe(0);
  });
});

describe('durable boundaries', () => {
  it('starts no candidate while a stream is open, so a commit never strands the streaming reply', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      compaction: { preserveRecentCount: 2 },
      schedule: schedule.adapter,
    });
    const phases = recordPhases(scheduler);
    const streamId = conversation.appendStreamingMessage('assistant');
    conversation.updateStreamingMessage(streamId, 'The');

    const outcome = scheduler.request();
    // The window opens, and the summary would return, between two tokens.
    schedule.fire();
    gated.release();
    await untilState(scheduler, (state) => state.phase !== 'running');
    conversation.updateStreamingMessage(streamId, 'The answer is 42');
    conversation.finalizeStreamingMessage(streamId);

    // Every token reached the reply the stream opened, and the stream closed.
    expect(conversation.getStreamingMessage()).toBeUndefined();
    const reply = conversation.getMessages().at(-1);
    expect(reply).toMatchObject({ id: streamId, role: 'assistant', content: 'The answer is 42' });
    expect(gated.signals).toHaveLength(0);
    expect(hasPublishedSummary(conversation)).toBe(false);

    // Closing the stream reached a durable boundary, which queued a new window.
    expect(schedule.scheduled).toBe(2);
    gated.arm();
    schedule.fire();
    gated.release();

    expect(await outcome).toMatchObject({ outcome: 'committed', candidates: 1 });
    expect(hasPublishedSummary(conversation)).toBe(true);
    expect(conversation.getMessages().at(-1)?.content).toBe('The answer is 42');
    expect(phases).toEqual(['pending', 'pending', 'running', 'committed']);
    expect(scheduler.state.counts).toMatchObject({ candidates: 1, deferred: 1, committed: 1 });
  });

  it('starts no candidate while tool calls are pending, so none is summarized away', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    // The default recency window keeps four messages: fewer than the pending calls.
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });
    const calls = Array.from({ length: 6 }, (_, index) => ({
      id: `call-${index}`,
      name: 'lookup',
      arguments: { index },
    }));
    const resultFor = (call: (typeof calls)[number]) => ({
      callId: call.id,
      outcome: 'success' as const,
      content: `result ${call.arguments.index}`,
    });
    conversation.appendToolCalls(calls);

    const outcome = scheduler.request();
    schedule.fire();
    gated.release();
    await untilState(scheduler, (state) => state.phase !== 'running');

    // Every result still finds its call, and a partial batch is not a boundary.
    conversation.appendToolResults(calls.slice(0, 3).map(resultFor));
    expect(schedule.scheduled).toBe(1);
    conversation.appendToolResults(calls.slice(3).map(resultFor));
    expect(conversation.getPendingToolCalls()).toEqual([]);
    expect(gated.signals).toHaveLength(0);
    expect(scheduler.state).toMatchObject({ phase: 'pending', candidate: 0 });

    // The last result reached the boundary and queued a new window.
    expect(schedule.scheduled).toBe(2);
    gated.arm();
    schedule.fire();
    gated.release();

    expect(await outcome).toMatchObject({ outcome: 'committed', candidates: 1 });
    expect(hasPublishedSummary(conversation)).toBe(true);
    // Each call the summary kept still has its result beside it.
    const kept = conversation.getMessages();
    const keptCalls = kept.filter((message) => message.role === 'tool-call');
    const keptResults = kept.filter((message) => message.role === 'tool-result');
    expect(keptCalls.map((message) => message.toolCall?.id)).toEqual(
      keptResults.map((message) => message.toolResult?.callId),
    );
    expect(conversation.getPendingToolCalls()).toEqual([]);
    expect(scheduler.state.counts).toMatchObject({ candidates: 1, deferred: 1, committed: 1 });
  });

  it('withdraws a request that is waiting for a durable boundary', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });
    const streamId = conversation.appendStreamingMessage('assistant');

    const outcome = scheduler.request();
    schedule.fire();
    expect(scheduler.state).toMatchObject({ phase: 'pending', counts: { deferred: 1 } });
    await scheduler.cancel();
    expect(await outcome).toEqual({ outcome: 'cancelled', reason: 'cancelled', candidates: 0 });

    // The withdrawn request no longer waits: reaching the boundary queues nothing.
    conversation.finalizeStreamingMessage(streamId);
    expect(schedule.scheduled).toBe(1);
    expect(gated.signals).toHaveLength(0);
    expect(scheduler.state).toMatchObject({ phase: 'cancelled', counts: { cancelled: 1 } });
  });
});

describe('scheduler starvation', () => {
  it('a window that never opens leaves work pending without blocking writes, and disposal withdraws it', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });

    const outcome = scheduler.request();
    for (let index = 0; index < 5; index++) {
      conversation.appendUserMessage(`still writing ${index}`);
      expect(scheduler.request()).toBe(outcome);
    }

    expect(scheduler.state).toMatchObject({ phase: 'pending', candidate: 0 });
    expect(scheduler.state.counts.candidates).toBe(0);
    expect(gated.signals).toHaveLength(0);
    expect(conversation.getMessages().at(-1)?.content).toBe('still writing 4');

    await scheduler.dispose();
    expect(await outcome).toMatchObject({ outcome: 'cancelled', reason: 'disposed' });
    expect(schedule.cancelled).toBe(1);
    expect(schedule.queued).toBe(0);
  });
});
