/**
 * COR-810 — revisioned conversation compaction commits.
 *
 * `Conversation.compact()` builds its summary and retained-recent-context
 * projection as an unpublished candidate from one base snapshot, then
 * publishes it only through a compare-and-swap on the controller revision
 * every snapshot and event already carries. A summarizer delayed past a
 * newer write must lose: the candidate is dropped, the newer history stays
 * byte-for-byte as it was, and the caller gets a typed `discarded` outcome.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import { Conversation } from '../src/history';
import {
  createConversationHistory,
  type CompactionAttempt,
  type ConversationCompactionResult,
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

/** A summarizer that holds every call until the gate opens. */
function gatedSummarizer(gate: Gate): Summarizer {
  return async (messages) => {
    await gate.opened;
    return `Summary of ${messages.length} messages`;
  };
}

function conversationWithHistory(
  environment: ConstructorParameters<typeof Conversation>[1] = {},
): Conversation {
  const conversation = new Conversation(
    createConversationHistory({ id: 'revisioned' }),
    environment,
  );
  for (let index = 0; index < 8; index++) {
    conversation.appendUserMessage(`question ${index}`);
    conversation.appendAssistantMessage(`answer ${index}`);
  }
  return conversation;
}

/** Everything a stale candidate could have touched, captured by value. */
function captureState(conversation: Conversation) {
  return {
    current: conversation.current,
    serialized: JSON.stringify(conversation.current),
    revision: conversation.revision,
    tree: JSON.stringify(conversation.snapshot().root),
    storeRevision: conversation.getSnapshot().revision,
  };
}

function expectStateUnchanged(
  conversation: Conversation,
  before: ReturnType<typeof captureState>,
): void {
  expect(conversation.current).toBe(before.current);
  expect(JSON.stringify(conversation.current)).toBe(before.serialized);
  expect(conversation.revision).toBe(before.revision);
  expect(JSON.stringify(conversation.snapshot().root)).toBe(before.tree);
  expect(conversation.getSnapshot().revision).toBe(before.storeRevision);
}

function hasPublishedSummary(conversation: Conversation): boolean {
  return conversation
    .getMessages({ includeHidden: true })
    .some((message) => message.metadata['compactionSummary'] === true);
}

function recordCompactionEvents(conversation: Conversation): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  for (const type of [
    'compaction.started',
    'compaction.completed',
    'compaction.stale-discarded',
    'compaction.failed',
    'compaction.cancelled',
  ] as const) {
    conversation.addEventListener(type, (event) => events.push(event));
  }
  return events;
}

function expectAttempt(
  attempt: CompactionAttempt | undefined,
  expected: Partial<CompactionAttempt>,
): CompactionAttempt {
  expect(attempt).toBeDefined();
  expect(attempt).toMatchObject(expected);
  expect(typeof attempt!.attemptId).toBe('string');
  expect(attempt!.attemptId.length).toBeGreaterThan(0);
  expect(Number.isFinite(attempt!.durationMs)).toBe(true);
  expect(attempt!.durationMs).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(attempt!.baseTokens)).toBe(true);
  return attempt!;
}

describe('revisioned compaction commits', () => {
  it('advances the one public controller revision on commit, with no private counter', async () => {
    const conversation = conversationWithHistory();
    const events = recordCompactionEvents(conversation);
    const baseRevision = conversation.revision;
    expect(conversation.getSnapshot().revision).toBe(baseRevision);
    expect(conversation.snapshot().controllerRevision).toBe(baseRevision);

    const result = await conversation.compact(async () => 'summary', { preserveRecentCount: 2 });

    expect(result.outcome).toBe('committed');
    expect(conversation.revision).toBe(baseRevision + 1);
    expect(result.revision).toBe(conversation.revision);
    expect(conversation.getSnapshot().revision).toBe(conversation.revision);
    expect(conversation.snapshot().controllerRevision).toBe(conversation.revision);

    const [started, completed] = events;
    expect(events.map((event) => event.type)).toEqual([
      'compaction.started',
      'compaction.completed',
    ]);
    // The attempt's base and observed revisions are values of the same
    // controller revision the events and snapshots carry — not a second
    // sequence that merely happens to agree.
    expect(started!.revision).toBe(baseRevision);
    expectAttempt(started!.compaction, { baseRevision, observedRevision: baseRevision });
    expect(completed!.revision).toBe(baseRevision + 1);
    expectAttempt(completed!.compaction, { baseRevision, observedRevision: baseRevision });
    expect(result.attempt).toEqual(completed!.compaction!);
  });

  it('keeps the summary an unpublished candidate while the attempt is in progress', async () => {
    const conversation = conversationWithHistory();
    const reachedSecondChunk = createGate();
    const secondChunk = createGate();
    let calls = 0;
    const before = captureState(conversation);

    const compacting = conversation.compact(
      async (messages) => {
        calls += 1;
        if (calls === 2) {
          reachedSecondChunk.release();
          await secondChunk.opened;
        }
        return `chunk ${calls} of ${messages.length}`;
      },
      { preserveRecentCount: 2 },
    );

    // One chunk has already been summarized: the attempt has made progress,
    // yet nothing about the model-visible history may have moved.
    await reachedSecondChunk.opened;
    expect(calls).toBe(2);
    expectStateUnchanged(conversation, before);
    expect(hasPublishedSummary(conversation)).toBe(false);

    secondChunk.release();
    const result = await compacting;

    expect(result.outcome).toBe('committed');
    expect(result.chunksProcessed).toBeGreaterThanOrEqual(2);
    expect(hasPublishedSummary(conversation)).toBe(true);
    expect(conversation.revision).toBe(before.revision + 1);
  });

  it('leaves the prior boundary active when the summarizer fails', async () => {
    const conversation = conversationWithHistory();
    const events = recordCompactionEvents(conversation);
    const before = captureState(conversation);

    const failing = conversation.compact(async () => {
      throw new Error('summarizer unavailable');
    });

    expect(failing).rejects.toThrow('summarizer unavailable');
    await failing.catch(() => undefined);
    expectStateUnchanged(conversation, before);
    expect(hasPublishedSummary(conversation)).toBe(false);

    const failed = events.find((event) => event.type === 'compaction.failed');
    expect(failed?.outcome).toBe('failed');
    const attempt = expectAttempt(failed?.compaction, {
      baseRevision: before.revision,
      observedRevision: before.revision,
    });
    expect(attempt.candidateTokens).toBeUndefined();
    expect(attempt.attemptId).toBe(events[0]!.compaction!.attemptId);
  });

  it('leaves the prior boundary active when the caller cancels the attempt', async () => {
    const conversation = conversationWithHistory();
    const events = recordCompactionEvents(conversation);
    const gate = createGate();
    const controller = new AbortController();
    const before = captureState(conversation);

    const compacting = conversation.compact(gatedSummarizer(gate), {
      signal: controller.signal,
    });
    controller.abort('caller stopped');
    gate.release();

    expect(compacting).rejects.toMatchObject({ code: 'error:operation-cancelled' });
    await compacting.catch(() => undefined);
    expectStateUnchanged(conversation, before);
    expect(hasPublishedSummary(conversation)).toBe(false);

    const cancelled = events.find((event) => event.type === 'compaction.cancelled');
    expect(cancelled?.outcome).toBe('cancelled');
    expectAttempt(cancelled?.compaction, {
      attemptId: events[0]!.compaction!.attemptId,
      baseRevision: before.revision,
      observedRevision: before.revision,
    });
  });

  it('leaves the prior boundary active when disposal cancels the attempt', async () => {
    const conversation = conversationWithHistory();
    const gate = createGate();
    const before = captureState(conversation);

    const compacting = conversation.compact(gatedSummarizer(gate));
    const disposal = conversation.dispose();
    gate.release();

    expect(compacting).rejects.toMatchObject({ code: 'error:operation-cancelled' });
    await disposal;
    expect(conversation.current).toBe(before.current);
    expect(JSON.stringify(conversation.current)).toBe(before.serialized);
    expect(conversation.revision).toBe(before.revision);
    expect(hasPublishedSummary(conversation)).toBe(false);
  });

  describe('a summarizer delayed past a newer write', () => {
    const races: ReadonlyArray<{
      readonly name: string;
      readonly prepare: (conversation: Conversation) => (conversation: Conversation) => void;
      readonly survived: (conversation: Conversation) => void;
    }> = [
      {
        name: 'appending a message',
        prepare: () => (conversation) => conversation.appendUserMessage('arrived mid-summary'),
        survived: (conversation) =>
          expect(conversation.getMessages().at(-1)?.content).toBe('arrived mid-summary'),
      },
      {
        name: 'appending a tool result',
        prepare: (conversation) => {
          conversation.appendToolCall({ id: 'call-1', name: 'lookup', arguments: { q: 'x' } });
          return (target) =>
            target.appendToolResult({ callId: 'call-1', outcome: 'success', content: 'found' });
        },
        survived: (conversation) =>
          expect(conversation.getMessages().at(-1)?.toolResult?.content).toBe('found'),
      },
      {
        name: 'streaming tokens',
        prepare: (conversation) => {
          const streamId = conversation.appendStreamingMessage('assistant');
          return (target) => target.updateStreamingMessage(streamId, 'partial tokens');
        },
        survived: (conversation) =>
          expect(conversation.getStreamingMessage()?.content).toBe('partial tokens'),
      },
      {
        name: 'finalizing a stream',
        prepare: (conversation) => {
          const streamId = conversation.appendStreamingMessage('assistant');
          conversation.updateStreamingMessage(streamId, 'complete answer');
          return (target) => target.finalizeStreamingMessage(streamId);
        },
        survived: (conversation) => {
          expect(conversation.getStreamingMessage()).toBeUndefined();
          expect(conversation.getMessages().at(-1)?.content).toBe('complete answer');
        },
      },
      {
        name: 'cancelling a stream',
        prepare: (conversation) => {
          const streamId = conversation.appendStreamingMessage('assistant');
          conversation.updateStreamingMessage(streamId, 'abandoned');
          return (target) => target.cancelStreamingMessage(streamId);
        },
        survived: (conversation) => {
          expect(conversation.getStreamingMessage()).toBeUndefined();
          expect(conversation.getMessages().at(-1)?.content).toBe('answer 7');
        },
      },
    ];

    for (const race of races) {
      it(`discards the stale candidate after ${race.name}`, async () => {
        const conversation = conversationWithHistory();
        const write = race.prepare(conversation);
        const events = recordCompactionEvents(conversation);
        const gate = createGate();
        const baseRevision = conversation.revision;
        const baseTokens = conversation.estimateTokens();

        const compacting = conversation.compact(gatedSummarizer(gate), {
          preserveRecentCount: 2,
        });
        write(conversation);
        const afterWrite = captureState(conversation);
        expect(afterWrite.revision).toBeGreaterThan(baseRevision);
        gate.release();

        const result: ConversationCompactionResult = await compacting;

        expect(result.outcome).toBe('discarded');
        if (result.outcome !== 'discarded') throw new Error('expected a discarded outcome');
        expect(result.reason).toBe('revision-conflict');
        expect(result.compacted).toBe(false);
        expect(result.messagesRemoved).toBe(0);
        expect(result.summaryContent).toBe('');
        expect(result.revision).toBe(afterWrite.revision);
        expectStateUnchanged(conversation, afterWrite);
        expect(hasPublishedSummary(conversation)).toBe(false);
        race.survived(conversation);

        const discarded = events.find((event) => event.type === 'compaction.stale-discarded');
        expect(discarded?.outcome).toBe('discarded');
        expect(discarded?.reason).toBe('revision-conflict');
        const attempt = expectAttempt(discarded?.compaction, {
          baseRevision,
          observedRevision: afterWrite.revision,
          baseTokens,
        });
        expect(attempt.candidateTokens).toBeGreaterThan(0);
        expect(result.attempt).toEqual(attempt);
        expect(events.some((event) => event.type === 'compaction.completed')).toBe(false);
      });
    }
  });

  it('reports a no-op attempt without moving the revision', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'short' }));
    conversation.appendUserMessage('only one');
    const events = recordCompactionEvents(conversation);
    const before = captureState(conversation);

    const result = await conversation.compact(async () => 'unused', { preserveRecentCount: 2 });

    expect(result.outcome).toBe('no-op');
    expect(result.compacted).toBe(false);
    expect(result.revision).toBe(before.revision);
    expectStateUnchanged(conversation, before);
    const completed = events.find((event) => event.type === 'compaction.completed');
    expect(completed?.outcome).toBe('completed');
    expectAttempt(completed?.compaction, {
      baseRevision: before.revision,
      observedRevision: before.revision,
      candidateTokens: completed!.compaction!.baseTokens,
    });
  });

  it('discards a no-op attempt whose base revision went stale', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'short-stale' }));
    conversation.appendUserMessage('only one');

    const compacting = conversation.compact(async () => 'unused', { preserveRecentCount: 2 });
    conversation.appendAssistantMessage('arrived before the no-op settled');
    const afterWrite = captureState(conversation);

    const result = await compacting;

    expect(result.outcome).toBe('discarded');
    expectStateUnchanged(conversation, afterWrite);
  });

  it('stamps every event of one attempt with its identity, duration, and token counts', async () => {
    const runtime = createManualRuntimeServices({ origin: '2030-01-01T00:00:00.000Z' });
    const conversation = conversationWithHistory({ runtime });
    const events = recordCompactionEvents(conversation);
    const gate = createGate();
    const baseRevision = conversation.revision;
    const baseTokens = conversation.estimateTokens();

    const compacting = conversation.compact(gatedSummarizer(gate), { preserveRecentCount: 2 });
    await runtime.advance(40);
    gate.release();
    const result = await compacting;

    const attemptId = `${runtime.identifierPrefix}-compaction-1`;
    const [started, completed] = events;
    expect(started!.compaction).toEqual({
      attemptId,
      baseRevision,
      observedRevision: baseRevision,
      durationMs: 0,
      baseTokens,
    });
    expect(completed!.compaction).toEqual({
      attemptId,
      baseRevision,
      observedRevision: baseRevision,
      durationMs: 40,
      baseTokens,
      candidateTokens: conversation.estimateTokens(),
    });
    expect(result.attempt).toEqual(completed!.compaction!);

    const second = await conversation.compact(async () => 'again', { preserveRecentCount: 2 });
    expect(second.attempt.attemptId).toBe(`${runtime.identifierPrefix}-compaction-2`);
    expect(second.attempt.baseRevision).toBe(baseRevision + 1);
  });

  it('keeps the synchronous result fields a caller already reads', async () => {
    const conversation = conversationWithHistory();
    const before = conversation.current.ids.length;

    const result = await conversation.compact(async (messages) => `Summary of ${messages.length}`, {
      preserveRecentCount: 4,
    });

    expect(result.compacted).toBe(true);
    expect(result.chunksProcessed).toBeGreaterThan(0);
    expect(result.messagesRemoved).toBe(before - 4);
    expect(result.summaryContent).toContain('Summary of');
    expect(conversation.current.ids).toHaveLength(5);
  });
});
