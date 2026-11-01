/**
 * What the wiring reports of a run's usage (COR-1983): the counts a `RUN_FINISHED` carries, under the
 * run's Bureau identifier, and nothing for a run that ended without one.
 */
import type { ChatSessionRequest, ChatStreamEvent, ConversationHistory } from '@lostgradient/chat';
import { appendUserMessage, createConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import type { Fetcher } from '../../lib/bureau-client.ts';
import { createChatRunWiring, type RunUsage, usageOfTerminal } from './run-wiring.ts';

const THREAD = 'thread-usage';

const stream = (events: readonly unknown[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const started = {
  type: 'RUN_STARTED',
  threadId: THREAD,
  runId: 'run-1',
  metadata: { '@lostgradient/bureau': { runId: 'native-1', sessionId: THREAD, durable: false } },
};

const finished = (extra: Record<string, unknown>) => ({
  type: 'RUN_FINISHED',
  threadId: THREAD,
  runId: 'run-1',
  outcome: { type: 'success' },
  ...extra,
});

function request(conversation: ConversationHistory): ChatSessionRequest {
  return {
    conversation,
    signal: new AbortController().signal,
    turn: 1,
    attachments: [],
    submissionId: 'submission-1',
    historyToken: { conversationId: conversation.id, generation: 0, revision: 0 },
    isCurrent: () => true,
  };
}

/** Runs one turn over a mount that answers `events`, and returns what the wiring reported. */
async function reported(events: readonly unknown[]): Promise<[string, RunUsage][]> {
  const told: [string, RunUsage][] = [];
  const conversation = appendUserMessage(createConversationHistory({ id: THREAD }), 'Hello');
  const fetchStub: Fetcher = async () => stream(events);
  const wiring = createChatRunWiring({
    agentName: () => 'assistant',
    fetch: fetchStub,
    conversation: () => conversation,
    onUsage: (runId, usage) => told.push([runId, usage]),
  });
  await Array.fromAsync(
    (await wiring.transport(request(conversation))) as AsyncIterable<ChatStreamEvent>,
  );
  return told;
}

describe('the usage of a run’s terminal event', () => {
  test('is reported under the run’s Bureau identifier', async () => {
    const told = await reported([
      started,
      finished({ usage: [{ inputTokens: 120, outputTokens: 30, totalTokens: 150 }] }),
    ]);
    expect(told).toEqual([['native-1', { inputTokens: 120, outputTokens: 30, totalTokens: 150 }]]);
  });

  test('keeps the counts the event carried and invents none', async () => {
    const told = await reported([started, finished({ usage: [{ outputTokens: 30 }] })]);
    expect(told).toEqual([['native-1', { outputTokens: 30 }]]);
  });

  test('is not reported for an event with no count', async () => {
    expect(await reported([started, finished({ usage: [{}] })])).toEqual([]);
    expect(await reported([started, finished({})])).toEqual([]);
  });
});

describe('usageOfTerminal', () => {
  test('reads only a RUN_FINISHED', () => {
    expect(usageOfTerminal({ type: 'RUN_STARTED', usage: [{ totalTokens: 3 }] })).toBeUndefined();
    expect(usageOfTerminal('RUN_FINISHED')).toBeUndefined();
    expect(usageOfTerminal({ type: 'RUN_FINISHED', usage: 'many' })).toBeUndefined();
  });

  test('drops a count that is not a finite, non-negative number', () => {
    expect(
      usageOfTerminal({
        type: 'RUN_FINISHED',
        usage: [{ inputTokens: Number.NaN, outputTokens: -1, totalTokens: '7' }, null, 4],
      }),
    ).toBeUndefined();
    expect(
      usageOfTerminal({
        type: 'RUN_FINISHED',
        usage: [{ inputTokens: 0, outputTokens: Number.POSITIVE_INFINITY }],
      }),
    ).toEqual({ inputTokens: 0 });
  });

  test('merges the entries in order, the later count winning', () => {
    expect(
      usageOfTerminal({
        type: 'RUN_FINISHED',
        usage: [{ inputTokens: 1 }, { inputTokens: 2, totalTokens: 5 }],
      }),
    ).toEqual({ inputTokens: 2, totalTokens: 5 });
  });
});
