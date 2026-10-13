import { describe, expect, test } from 'bun:test';
import { createConversationHistory } from '../components/chat/builders.ts';
import {
  abortedFrame,
  createFrameHarness,
  rolesOf,
  type FrameInput,
} from './session-controller-frame-test-support.ts';

const identity = { toolCallId: 'call-1', toolName: 'lookup' };
const started: FrameInput = { type: 'tool.started', ...identity };
const progress: FrameInput = {
  type: 'tool.progress',
  ...identity,
  percent: 40,
  message: 'working',
};
const failed: FrameInput = { type: 'tool.error', ...identity, error: { code: 'E_FAIL' } };
const denied: FrameInput = { type: 'tool.policy-denied', ...identity, reason: 'blocked' };
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

async function observe(frames: FrameInput[], executionOwner: 'browser' | 'server' = 'server') {
  const harness = createFrameHarness({ turns: [[...frames, abortedFrame()]], executionOwner });
  const thrown = await harness.send();
  return { harness, thrown };
}

describe('tool activity frames', () => {
  test('tool.started is recorded and notified', async () => {
    const { harness } = await observe([started]);
    expect(harness.toolActivity).toEqual([{ ...identity, status: 'started' }]);
  });

  test('tool.progress carries percent and message, and omits absent fields', async () => {
    const { harness } = await observe([{ type: 'tool.progress', ...identity }, progress]);
    expect(harness.toolActivity).toEqual([
      { ...identity, status: 'progress' },
      { ...identity, status: 'progress', percent: 40, message: 'working' },
    ]);
    expect(Object.keys(harness.toolActivity[0] ?? {})).not.toContain('percent');
  });

  test('tool.error carries the error payload', async () => {
    const { harness } = await observe([failed]);
    expect(harness.toolActivity).toEqual([
      { ...identity, status: 'error', error: { code: 'E_FAIL' } },
    ]);
  });

  test('tool.policy-denied carries the reason, and omits it when absent', async () => {
    const withReason = await observe([denied]);
    expect(withReason.harness.toolActivity).toEqual([
      { ...identity, status: 'policy-denied', reason: 'blocked' },
    ]);
    const without = await observe([{ type: 'tool.policy-denied', ...identity }]);
    expect(Object.keys(without.harness.toolActivity[0] ?? {})).not.toContain('reason');
  });

  test('a frame for a call with no row neither throws nor adds a row', async () => {
    for (const frame of [started, progress, failed, denied]) {
      const { harness, thrown } = await observe([frame]);
      expect(thrown).toBeUndefined();
      expect(harness.errors).toEqual([]);
      expect(harness.toolActivity).toHaveLength(1);
      expect(rolesOf(harness.conversation)).toEqual(['user']);
    }
  });

  test('progress replaces a non-terminal record, and a repeated started is dropped', async () => {
    const { harness } = await observe([started, started, progress, progress]);
    expect(harness.toolActivity.map((activity) => activity.status)).toEqual([
      'started',
      'progress',
      'progress',
    ]);
  });

  test('error and policy-denied replace an open record', async () => {
    const { harness } = await observe([started, progress, failed]);
    expect(harness.toolActivity.map((activity) => activity.status)).toEqual([
      'started',
      'progress',
      'error',
    ]);
  });

  test('a record that errored is terminal', async () => {
    const { harness } = await observe([failed, started, progress, denied, failed]);
    expect(harness.toolActivity.map((activity) => activity.status)).toEqual(['error']);
  });

  test('a record that was policy-denied is terminal', async () => {
    const { harness } = await observe([denied, started, progress, failed, denied]);
    expect(harness.toolActivity.map((activity) => activity.status)).toEqual(['policy-denied']);
  });

  test('a call already settled by tool_result is terminal', async () => {
    const { harness } = await observe([call, result, started, progress, failed, denied]);
    expect(harness.toolActivity).toEqual([]);
  });

  test('a call already settled by tool.settled is terminal', async () => {
    const { harness } = await observe([
      call,
      {
        type: 'tool.settled',
        ...identity,
        result: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      started,
    ]);
    expect(harness.toolActivity).toEqual([]);
  });

  test('activity frames leave continuation untouched in a browser-owned run', async () => {
    const without = createFrameHarness({
      executionOwner: 'browser',
      turns: [[call, result, completed], [{ type: 'run.aborted' }]],
    });
    const withActivity = createFrameHarness({
      executionOwner: 'browser',
      turns: [[started, progress, call, failed, result, completed], [{ type: 'run.aborted' }]],
    });
    await without.send();
    await withActivity.send();
    expect(without.requests).toEqual([1, 2]);
    expect(withActivity.requests).toEqual(without.requests);
    expect(rolesOf(withActivity.conversation)).toEqual(rolesOf(without.conversation));
    expect(withActivity.toolResults).toHaveLength(1);
  });

  test('a throwing onToolActivity reaches onError once and does not fail the run', async () => {
    const harness = createFrameHarness({
      turns: [[started, abortedFrame()]],
      throwingObserver: 'onToolActivity',
    });
    expect(await harness.send()).toBeUndefined();
    // The record is still present: the state change precedes the observer.
    expect(harness.toolActivity).toHaveLength(1);
    expect(harness.errors).toEqual([harness.thrown]);
  });
});
