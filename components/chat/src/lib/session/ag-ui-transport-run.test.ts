import { describe, expect, test } from 'bun:test';
import { appendMessages } from '../components/chat/builders.ts';
import { AGUIChatTransportError } from './ag-ui-transport-error.ts';
import {
  bodies,
  completedConversation,
  emptyConversation,
  failure,
  frames,
  runFinished,
  runStarted,
  transcript,
} from './ag-ui-transport-test-support.ts';
import { decodeChatStreamEvents, encodeChatStreamEvent } from './stream-event-codec.ts';

describe('AG-UI RUN_* events', () => {
  test('RUN_STARTED becomes run.started carrying the run id', async () => {
    const all = await frames([runStarted, runFinished]);
    expect(all[0]).toEqual({ type: 'run.started', runId: 'run-1', wireVersion: 3, sequence: 0 });
  });

  test('RUN_FINISHED becomes run.completed carrying the history the run was asked from', async () => {
    const all = await frames([runStarted, runFinished]);
    expect(all.at(-1)).toMatchObject({
      type: 'run.completed',
      content: '',
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: 'stop',
    });
    expect(completedConversation(all).ids).toEqual([]);
  });

  test('RUN_FINISHED sums reported usage', async () => {
    const all = await frames([
      runStarted,
      {
        ...runFinished,
        usage: [
          { inputTokens: 3, outputTokens: 4 },
          { inputTokens: 1, totalTokens: 9 },
        ],
      },
    ]);
    expect(all.at(-1)).toMatchObject({ usage: { prompt: 4, completion: 4, total: 16 } });
  });

  test('an interrupt outcome completes the run and says so in the finish reason', async () => {
    const all = await frames([
      runStarted,
      {
        ...runFinished,
        outcome: { type: 'interrupt', interrupts: [{ id: 'i1', reason: 'approval' }] },
      },
    ]);
    expect(all.at(-1)).toMatchObject({ type: 'run.completed', finishReason: 'interrupt' });
  });

  test('a cancelled outcome becomes run.aborted', async () => {
    expect(await bodies([runStarted, { ...runFinished, outcome: { type: 'cancelled' } }])).toEqual([
      { type: 'run.started', runId: 'run-1' },
      { type: 'run.aborted', reason: 'cancelled' },
    ]);
  });

  test('RUN_ERROR becomes run.error, folding the code into the message', async () => {
    expect(
      await bodies([
        runStarted,
        { type: 'RUN_ERROR', message: 'The model refused.', code: 'REFUSED' },
      ]),
    ).toEqual([
      { type: 'run.started', runId: 'run-1' },
      {
        type: 'run.error',
        error: {
          name: 'AGUIRunError',
          message: 'The model refused. (REFUSED)',
          kind: 'generate',
          code: 'UNKNOWN',
        },
      },
    ]);
    const bare = await bodies([runStarted, { type: 'RUN_ERROR', message: 'Nope.' }]);
    expect(bare[1]).toMatchObject({ error: { message: 'Nope.' } });
  });

  test('stamps one wire version and a strictly increasing sequence on every frame', async () => {
    const all = await frames([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      runFinished,
    ]);
    expect(all.map((frame) => frame.wireVersion)).toEqual([3, 3, 3, 3, 3]);
    expect(all.map((frame) => frame.sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  test('every frame it emits survives the native wire codec', async () => {
    const all = await frames([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      runFinished,
    ]);
    const ndjson = all.map((frame) => encodeChatStreamEvent(frame)).join('');
    expect(await Array.fromAsync(decodeChatStreamEvents(ndjson))).toEqual(all);
  });

  test('a stream that ends without RUN_FINISHED or RUN_ERROR fails', async () => {
    const error = await failure([runStarted]);
    expect(error).toBeInstanceOf(AGUIChatTransportError);
    expect(error).toMatchObject({ kind: 'incomplete-stream', eventIndex: undefined });
  });

  test('RUN_FINISHED naming another run fails', async () => {
    const error = await failure([runStarted, { ...runFinished, runId: 'other' }]);
    expect(error).toMatchObject({ kind: 'protocol', eventIndex: 1 });
  });

  test('keeps the history the run was asked from beneath what it produced', async () => {
    const conversation = appendMessages(emptyConversation(), { role: 'user', content: 'Hello' });
    const all = await frames(
      [
        runStarted,
        { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'ok' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
        runFinished,
      ],
      conversation,
    );
    expect(completedConversation(all).ids.slice(0, 1)).toEqual([...conversation.ids]);
    expect(transcript(completedConversation(all))).toEqual([
      ['user', 'Hello'],
      ['assistant', 'ok'],
    ]);
  });
});
