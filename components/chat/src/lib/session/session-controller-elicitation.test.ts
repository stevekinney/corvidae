import { describe, expect, test } from 'bun:test';
import type { ToolAction } from 'conversationalist';
import { createConversationHistory } from '../components/chat/builders.ts';
import {
  abortedFrame,
  createFrameHarness,
  type FrameInput,
} from './session-controller-frame-test-support.ts';

const request = (
  requestId = 'request-1',
  extra: Partial<{ toolCallId: string }> = {},
): FrameInput => ({
  type: 'elicitation.requested',
  requestId,
  message: 'May I?',
  ...extra,
});
const resolution = (
  requestId = 'request-1',
  accepted = true,
  extra: Partial<{ toolCallId: string }> = {},
): FrameInput => ({ type: 'elicitation.resolved', requestId, accepted, ...extra });
const completed: FrameInput = {
  type: 'run.completed',
  conversation: createConversationHistory({ id: 'frames' }),
  content: '',
  usage: { prompt: 0, completion: 0, total: 0 },
  finishReason: 'stop',
};
const approval: ToolAction = {
  type: 'approval',
  message: 'Approve this tool call',
  risk: 'high',
  operation: { kind: 'command', command: 'echo approval', argsPreview: { ok: true } },
  policyVersion: 'test-policy',
  idempotencyKey: 'test-approval',
};
const call: FrameInput = { type: 'tool_call', id: 'call-1', name: 'lookup', arguments: {} };
const toolResult: FrameInput = {
  type: 'tool_result',
  callId: 'call-1',
  outcome: 'success',
  content: 'ok',
};

async function observe(frames: FrameInput[]) {
  const harness = createFrameHarness({ turns: [[...frames, abortedFrame()]] });
  await harness.send();
  return harness;
}

describe('elicitation frames', () => {
  test('requested records and notifies with its own fields', async () => {
    const harness = await observe([
      { type: 'elicitation.requested', requestId: 'r', message: 'Proceed?', toolCallId: 'call-1' },
      { type: 'elicitation.requested', requestId: 's', message: 'Which?', action: approval },
      { type: 'elicitation.requested', requestId: 't', message: 'Plain?' },
    ]);
    expect(harness.elicitations).toEqual([
      { status: 'requested', requestId: 'r', message: 'Proceed?', toolCallId: 'call-1' },
      { status: 'requested', requestId: 's', message: 'Which?', action: approval },
      { status: 'requested', requestId: 't', message: 'Plain?' },
    ]);
  });

  test('resolved settles the same requestId and notifies', async () => {
    const harness = await observe([request(), resolution('request-1', false)]);
    expect(harness.elicitations).toEqual([
      { status: 'requested', requestId: 'request-1', message: 'May I?' },
      { status: 'resolved', requestId: 'request-1', accepted: false },
    ]);
  });

  test('a resolution for a different requestId leaves the request pending and notifies nothing', async () => {
    const harness = await observe([request('a'), resolution('b')]);
    expect(harness.elicitations).toHaveLength(1);
    const later = await observe([request('a'), resolution('b'), resolution('a')]);
    expect(later.elicitations.map((activity) => activity.status)).toEqual([
      'requested',
      'resolved',
    ]);
  });

  test('a resolution for a never-requested id is dropped', async () => {
    const harness = await observe([resolution('ghost')]);
    expect(harness.elicitations).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  test('a duplicate request notifies once', async () => {
    const harness = await observe([request(), request()]);
    expect(harness.elicitations).toHaveLength(1);
  });

  test('a duplicate request after resolution is ignored too', async () => {
    const harness = await observe([request(), resolution(), request()]);
    expect(harness.elicitations.map((activity) => activity.status)).toEqual([
      'requested',
      'resolved',
    ]);
  });

  test('a second resolution notifies nothing', async () => {
    const harness = await observe([request(), resolution(), resolution('request-1', false)]);
    expect(harness.elicitations.map((activity) => activity.status)).toEqual([
      'requested',
      'resolved',
    ]);
  });

  test('the resolved record takes toolCallId from its own frame only', async () => {
    const omitted = await observe([request('r', { toolCallId: 'a' }), resolution('r')]);
    expect(omitted.elicitations[1]).toEqual({ status: 'resolved', requestId: 'r', accepted: true });
    const differing = await observe([
      request('r', { toolCallId: 'a' }),
      resolution('r', true, { toolCallId: 'b' }),
    ]);
    expect(differing.elicitations).toHaveLength(2);
    expect(differing.elicitations[1]).toEqual({
      status: 'resolved',
      requestId: 'r',
      accepted: true,
      toolCallId: 'b',
    });
  });

  test('a request pending when the run ends is discarded without notification', async () => {
    const aborted = await observe([request()]);
    expect(aborted.elicitations).toHaveLength(1);
    const harness = createFrameHarness({ turns: [[request(), completed]] });
    await harness.send();
    expect(harness.elicitations).toHaveLength(1);
  });

  test('a pending request survives into the next turn of the same run', async () => {
    const harness = createFrameHarness({
      executionOwner: 'browser',
      turns: [
        [call, toolResult, request(), completed],
        [resolution(), abortedFrame()],
      ],
    });
    expect(await harness.send()).toBeUndefined();
    expect(harness.requests).toEqual([1, 2]);
    expect(harness.elicitations.map((activity) => activity.status)).toEqual([
      'requested',
      'resolved',
    ]);
  });

  test('a throwing onElicitation reports once, keeps the record, and does not fail the run', async () => {
    const harness = createFrameHarness({
      turns: [[request(), request(), abortedFrame()]],
      throwingObserver: 'onElicitation',
    });
    expect(await harness.send()).toBeUndefined();
    expect(harness.errors).toEqual([harness.thrown]);
    expect(harness.elicitations).toHaveLength(1);
  });

  test('a request carrying an action does not touch approval state or continuation', async () => {
    const withAction = createFrameHarness({
      executionOwner: 'browser',
      turns: [
        [
          call,
          toolResult,
          { type: 'elicitation.requested', requestId: 'r', message: 'Allow?', action: approval },
          completed,
        ],
        [abortedFrame()],
      ],
    });
    await withAction.send();
    expect(withAction.requests).toEqual([1, 2]);
  });
});
