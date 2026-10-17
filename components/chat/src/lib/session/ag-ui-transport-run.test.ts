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
import { UNSTARTED_RUN_ID } from './ag-ui-transport.ts';
import { decodeChatStreamEvents, encodeChatStreamEvent } from './stream-event-codec.ts';

describe('AG-UI RUN_* events', () => {
  test('RUN_STARTED becomes run.started carrying the run id', async () => {
    const all = await frames([runStarted, runFinished]);
    expect(all[0]).toEqual({
      type: 'run.started',
      runId: 'run-1',
      threadId: 'thread-1',
      wireVersion: 3,
      sequence: 0,
    });
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
      { type: 'run.started', runId: 'run-1', threadId: 'thread-1' },
      { type: 'run.aborted', reason: 'cancelled' },
    ]);
  });

  test('RUN_ERROR becomes run.error: the backend message, its code kept as the backend code', async () => {
    expect(
      await bodies([
        runStarted,
        { type: 'RUN_ERROR', message: 'The model refused.', code: 'REFUSED' },
      ]),
    ).toEqual([
      { type: 'run.started', runId: 'run-1', threadId: 'thread-1' },
      {
        type: 'run.error',
        error: {
          name: 'AGUIRunError',
          message: 'The model refused.',
          kind: 'generate',
          code: 'UNKNOWN',
          backendCode: 'REFUSED',
        },
      },
    ]);
  });

  test('RUN_ERROR maps its code to the wire code only on an exact match', async () => {
    const known = await bodies([
      runStarted,
      { type: 'RUN_ERROR', message: 'Over.', code: 'BUDGET_EXCEEDED' },
    ]);
    expect(known[1]).toMatchObject({
      error: { name: 'AGUIRunError', code: 'BUDGET_EXCEEDED', backendCode: 'BUDGET_EXCEEDED' },
    });
    const near = await bodies([
      runStarted,
      { type: 'RUN_ERROR', message: 'x', code: 'budget_exceeded' },
    ]);
    expect(near[1]).toMatchObject({ error: { code: 'UNKNOWN', backendCode: 'budget_exceeded' } });
    const bare = await bodies([runStarted, { type: 'RUN_ERROR', message: 'Nope.' }]);
    const error = (bare[1] as { error: object }).error;
    expect(error).toEqual({
      name: 'AGUIRunError',
      message: 'Nope.',
      kind: 'generate',
      code: 'UNKNOWN',
    });
  });

  test('RUN_ERROR as the first event is accepted, behind the run.started a version 3 stream opens with', async () => {
    const all = await frames([
      { type: 'RUN_ERROR', message: 'auth failed', code: 'UNAUTHORIZED', threadId: 'thread-9' },
    ]);
    expect(all.map((frame) => frame.type)).toEqual(['run.started', 'run.error']);
    expect(all[0]).toMatchObject({ runId: UNSTARTED_RUN_ID, threadId: 'thread-9' });
    expect(UNSTARTED_RUN_ID).toBe('ag-ui:unstarted');
    expect(all[1]).toMatchObject({
      error: { message: 'auth failed', name: 'AGUIRunError', backendCode: 'UNAUTHORIZED' },
    });
    const ndjson = all.map((frame) => encodeChatStreamEvent(frame)).join('');
    expect(await Array.fromAsync(decodeChatStreamEvents(ndjson))).toEqual(all);
    const bare = await frames([{ type: 'RUN_ERROR', message: 'auth failed' }]);
    expect(bare[0]).not.toHaveProperty('threadId');
  });

  test('RUN_ERROR names the thread it belongs to, and a different one fails', async () => {
    const ok = await frames([
      runStarted,
      { type: 'RUN_ERROR', message: 'x', threadId: 'thread-1' },
    ]);
    expect(ok.at(-1)?.type).toBe('run.error');
    const error = await failure([
      runStarted,
      { type: 'RUN_ERROR', message: 'x', threadId: 'other' },
    ]);
    expect(error).toMatchObject({ kind: 'protocol', eventIndex: 1 });
  });

  test('RUN_STARTED keeps the parent run it branched from', async () => {
    const all = await frames([{ ...runStarted, parentRunId: 'run-0' }, runFinished]);
    expect(all[0]).toMatchObject({ runId: 'run-1', threadId: 'thread-1', parentRunId: 'run-0' });
  });

  test('RUN_FINISHED sums cache usage into the counters it maps to, and omits them when unreported', async () => {
    const reported = await frames([
      runStarted,
      {
        ...runFinished,
        usage: [
          { inputTokens: 10, outputTokens: 2, cachedInputTokens: 6, cacheWriteInputTokens: 1 },
          { inputTokens: 5, outputTokens: 1, cachedInputTokens: 2 },
        ],
      },
    ]);
    expect(reported.at(-1)).toMatchObject({
      usage: { prompt: 15, completion: 3, total: 18, cacheReadTokens: 8, cacheCreationTokens: 1 },
    });
    const plain = await frames([runStarted, { ...runFinished, usage: [{ inputTokens: 1 }] }]);
    const usage = (plain.at(-1) as { usage: object }).usage;
    expect(Object.keys(usage).sort()).toEqual(['completion', 'prompt', 'total']);
  });

  test('RUN_FINISHED naming another thread fails', async () => {
    const error = await failure([runStarted, { ...runFinished, threadId: 'other' }]);
    expect(error).toMatchObject({ kind: 'protocol', eventIndex: 1 });
    expect((error as Error).message).toContain('thread other');
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
