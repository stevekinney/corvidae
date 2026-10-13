import { describe, expect, test } from 'bun:test';
import { createConversationHistory, isStreamingMessage } from '../components/chat/builders.ts';
import {
  abortedFrame,
  createFrameHarness,
  rolesOf,
  type FrameInput,
} from './session-controller-frame-test-support.ts';

const call: FrameInput = { type: 'tool_call', id: 'call-1', name: 'lookup', arguments: {} };
const result: FrameInput = {
  type: 'tool_result',
  callId: 'call-1',
  outcome: 'success',
  content: 'ok',
};
const completed: FrameInput = {
  type: 'run.completed',
  conversation: createConversationHistory({ id: 'frames' }),
  content: '',
  usage: { prompt: 0, completion: 0, total: 0 },
  finishReason: 'stop',
};

describe('run.aborted', () => {
  test('notifies onRunAborted once with the reason and does not fail the run', async () => {
    const harness = createFrameHarness({ turns: [[abortedFrame('user stopped')]] });
    expect(await harness.send()).toBeUndefined();
    expect(harness.aborted).toEqual([{ reason: 'user stopped' }]);
    expect(harness.errors).toEqual([]);
  });

  test('omits the reason when the frame has none', async () => {
    const harness = createFrameHarness({ turns: [[abortedFrame()]] });
    await harness.send();
    expect(harness.aborted).toHaveLength(1);
    expect(Object.keys(harness.aborted[0] ?? {})).toEqual([]);
  });

  test('finalizes the streaming row when the turn produced text', async () => {
    const harness = createFrameHarness({
      turns: [[{ type: 'text', text: 'partial' }, abortedFrame()]],
    });
    await harness.send();
    expect(rolesOf(harness.conversation)).toEqual(['user', 'assistant']);
    const row = harness.conversation.messages[harness.conversation.ids.at(-1) ?? ''];
    expect(row?.content).toBe('partial');
    expect(Object.values(harness.conversation.messages).some(isStreamingMessage)).toBe(false);
  });

  test('removes the streaming row when the turn produced no text', async () => {
    const harness = createFrameHarness({ turns: [[abortedFrame()]] });
    await harness.send();
    expect(rolesOf(harness.conversation)).toEqual(['user']);
  });

  test('does not continue a browser-owned turn whose tool calls are all resolved', async () => {
    const harness = createFrameHarness({
      executionOwner: 'browser',
      turns: [[call, result, abortedFrame()], [completed]],
    });
    expect(await harness.send()).toBeUndefined();
    expect(harness.requests).toEqual([1]);
  });

  test('a throwing onRunAborted reports once, still resolves, and settles rows', async () => {
    const harness = createFrameHarness({
      executionOwner: 'browser',
      turns: [[{ type: 'text', text: 'partial' }, call, result, abortedFrame()], [completed]],
      throwingObserver: 'onRunAborted',
    });
    expect(await harness.send()).toBeUndefined();
    expect(harness.errors).toEqual([harness.thrown]);
    expect(harness.requests).toEqual([1]);
    expect(Object.values(harness.conversation.messages).some(isStreamingMessage)).toBe(false);
    expect(rolesOf(harness.conversation)).toContain('assistant');
  });

  test('a frame after run.aborted rejects, reports once, and never notifies', async () => {
    for (const asBytes of [false, true]) {
      const harness = createFrameHarness({
        asBytes,
        turns: [[abortedFrame(), { type: 'text', text: 'late' }]],
      });
      const error = await harness.send();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Invalid chat stream event: frame arrived after the terminal frame',
      );
      expect(harness.errors).toHaveLength(1);
      expect(harness.aborted).toEqual([]);
    }
  });

  test('a stream:error followed by run.error reports exactly once', async () => {
    const harness = createFrameHarness({
      turns: [
        [
          { type: 'stream:error', error: 'raw' },
          {
            type: 'run.error',
            error: { name: 'AgentRunError', message: 'failed', kind: 'generate', code: 'UNKNOWN' },
          },
        ],
      ],
    });
    await harness.send();
    expect(harness.errors).toHaveLength(1);
  });
});
