import { describe, expect, test } from 'bun:test';
import { createConversationHistory } from '../components/chat/builders.ts';
import { IGNORED_STREAM_EVENT_TYPES } from './session-controller-events.ts';
import {
  abortedFrame,
  createFrameHarness,
  rolesOf,
  type FrameHarness,
  type FrameInput,
} from './session-controller-frame-test-support.ts';
import { ChatRunFailureError } from './session-controller-support.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

type EventType = ChatStreamEvent['type'];

/** One frame of every `ChatStreamEvent` type; a missing or mismatched key fails `typecheck`. */
const frames: { [K in EventType]: Extract<ChatStreamEvent, { type: K }> } = {
  text: { type: 'text', text: 'hello', wireVersion: 2, sequence: 0 },
  tool_call: {
    type: 'tool_call',
    id: 'call-1',
    name: 'lookup',
    arguments: {},
    wireVersion: 2,
    sequence: 0,
  },
  tool_result: {
    type: 'tool_result',
    callId: 'call-1',
    outcome: 'success',
    content: 'ok',
    wireVersion: 2,
    sequence: 0,
  },
  'stream:block-start': {
    type: 'stream:block-start',
    block: { id: 'b', type: 'text', index: 0, content: '', complete: false },
    wireVersion: 2,
    sequence: 0,
  },
  'stream:block-delta': {
    type: 'stream:block-delta',
    block: { id: 'b', type: 'text', index: 0, content: 'x', complete: false },
    delta: 'x',
    wireVersion: 2,
    sequence: 0,
  },
  'stream:block-complete': {
    type: 'stream:block-complete',
    block: { id: 'b', type: 'text', index: 0, content: 'x', complete: true },
    wireVersion: 2,
    sequence: 0,
  },
  'stream:text-delta': {
    type: 'stream:text-delta',
    content: 'hello',
    accumulated: 'hello',
    wireVersion: 2,
    sequence: 0,
  },
  'stream:tool-call-start': {
    type: 'stream:tool-call-start',
    toolName: 'lookup',
    blockId: 'b',
    wireVersion: 2,
    sequence: 0,
  },
  'stream:tool-call-delta': {
    type: 'stream:tool-call-delta',
    toolName: 'lookup',
    blockId: 'b',
    partialArguments: '{',
    wireVersion: 2,
    sequence: 0,
  },
  'stream:tool-call-complete': {
    type: 'stream:tool-call-complete',
    toolName: 'lookup',
    blockId: 'b',
    arguments: {},
    wireVersion: 2,
    sequence: 0,
  },
  'stream:usage': {
    type: 'stream:usage',
    usage: { prompt: 1, completion: 1, total: 2 },
    wireVersion: 2,
    sequence: 0,
  },
  'stream:complete': {
    type: 'stream:complete',
    state: { blocks: [], textContent: '', toolCalls: [], complete: true },
    wireVersion: 2,
    sequence: 0,
  },
  'stream:error': { type: 'stream:error', error: 'boom', wireVersion: 2, sequence: 0 },
  'tool.started': {
    type: 'tool.started',
    toolCallId: 'call-1',
    toolName: 'lookup',
    wireVersion: 2,
    sequence: 0,
  },
  'tool.progress': {
    type: 'tool.progress',
    toolCallId: 'call-1',
    toolName: 'lookup',
    percent: 50,
    message: 'halfway',
    wireVersion: 2,
    sequence: 0,
  },
  'tool.settled': {
    type: 'tool.settled',
    toolCallId: 'call-1',
    toolName: 'lookup',
    result: { callId: 'call-1', outcome: 'success', content: 'ok' },
    wireVersion: 2,
    sequence: 0,
  },
  'tool.error': {
    type: 'tool.error',
    toolCallId: 'call-1',
    toolName: 'lookup',
    error: 'failed',
    wireVersion: 2,
    sequence: 0,
  },
  'tool.policy-denied': {
    type: 'tool.policy-denied',
    toolCallId: 'call-1',
    toolName: 'lookup',
    reason: 'not allowed',
    wireVersion: 2,
    sequence: 0,
  },
  'run.completed': {
    type: 'run.completed',
    conversation: createConversationHistory({ id: 'frames' }),
    content: '',
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'stop',
    wireVersion: 2,
    sequence: 0,
  },
  'run.error': {
    type: 'run.error',
    error: { name: 'AgentRunError', message: 'failed', kind: 'generate', code: 'UNKNOWN' },
    wireVersion: 2,
    sequence: 0,
  },
  'run.tripwire': {
    type: 'run.tripwire',
    error: { name: 'AgentRunError', message: 'tripped', kind: 'policy', code: 'TRIPWIRE' },
    wireVersion: 2,
    sequence: 0,
  },
  'run.aborted': { type: 'run.aborted', reason: 'user', wireVersion: 2, sequence: 0 },
  'run.started': { type: 'run.started', runId: 'run-1', wireVersion: 3, sequence: 0 },
  'assistant.step.started': {
    type: 'assistant.step.started',
    step: 0,
    messageId: 'host-0',
    wireVersion: 2,
    sequence: 0,
  },
  'assistant.step.completed': {
    type: 'assistant.step.completed',
    step: 0,
    messageId: 'host-0',
    wireVersion: 2,
    sequence: 0,
  },
  'elicitation.requested': {
    type: 'elicitation.requested',
    requestId: 'request-1',
    message: 'May I?',
    wireVersion: 2,
    sequence: 0,
  },
  'elicitation.resolved': {
    type: 'elicitation.resolved',
    requestId: 'request-1',
    accepted: true,
    wireVersion: 2,
    sequence: 0,
  },
};

type IfEquals<T, U, Y = true, N = false> =
  (<G>() => G extends T ? 1 : 2) extends <G>() => G extends U ? 1 : 2 ? Y : N;
function assertTypesEqual<_T extends true>(): void {}

const reducedTypes = [
  'run.started',
  'text',
  'stream:text-delta',
  'tool_call',
  'tool_result',
  'tool.settled',
  'assistant.step.started',
  'assistant.step.completed',
  'tool.started',
  'tool.progress',
  'tool.error',
  'tool.policy-denied',
  'elicitation.requested',
  'elicitation.resolved',
] as const;
const terminalTypes = ['run.completed', 'run.error', 'run.tripwire', 'run.aborted'] as const;

type Reduced = (typeof reducedTypes)[number];
type Ignored = (typeof IGNORED_STREAM_EVENT_TYPES)[number];
type Terminal = (typeof terminalTypes)[number];

// Coverage: every wire type is in exactly one class, so a type added to the
// codec without a class here fails `typecheck`.
assertTypesEqual<IfEquals<EventType, Reduced | Ignored | Terminal>>();
// Disjointness: no type is claimed by two classes.
assertTypesEqual<IfEquals<Extract<Reduced, Ignored>, never>>();
assertTypesEqual<IfEquals<Extract<Reduced, Terminal>, never>>();
assertTypesEqual<IfEquals<Extract<Ignored, Terminal>, never>>();

/** Frames a type needs ahead of it to be observable. */
const preludes: { [K in Reduced]?: FrameInput[] } = {
  tool_result: [frames.tool_call],
  'tool.settled': [frames.tool_call],
  'assistant.step.completed': [frames['assistant.step.started']],
  'elicitation.resolved': [frames['elicitation.requested']],
};

const toolFrame = { toolCallId: 'call-1', toolName: 'lookup' } as const;

/** What a run that carried one frame of the type must have done, observed before the closer. */
const observations: { [K in Reduced]: (harness: FrameHarness) => void } = {
  'run.started': (harness) => {
    // The run's identity is bookkeeping, not a row: the transcript is exactly
    // the user's message and the open assistant placeholder.
    expect(rolesOf(harness.snapshot ?? harness.conversation)).toEqual(['user', 'assistant']);
  },
  text: (harness) => {
    expect(harness.snapshot?.messages[harness.snapshot.ids.at(-1) ?? '']?.content).toBe('hello');
  },
  'stream:text-delta': (harness) => {
    expect(harness.snapshot?.messages[harness.snapshot.ids.at(-1) ?? '']?.content).toBe('hello');
  },
  tool_call: (harness) => {
    expect(rolesOf(harness.snapshot ?? harness.conversation)).toContain('tool-call');
  },
  tool_result: (harness) => {
    expect(rolesOf(harness.snapshot ?? harness.conversation)).toContain('tool-result');
    expect(harness.toolResults).toHaveLength(1);
  },
  'tool.settled': (harness) => {
    expect(rolesOf(harness.snapshot ?? harness.conversation)).toContain('tool-result');
    expect(harness.toolResults).toHaveLength(1);
  },
  'assistant.step.started': (harness) => {
    expect(harness.snapshot?.ids).toContain('host-0');
  },
  'assistant.step.completed': (harness) => {
    // The step produced no text, so settling it cancels the empty row that
    // `assistant.step.started` alone leaves in place.
    expect(harness.snapshot).toBeDefined();
    expect(harness.snapshot?.ids).not.toContain('host-0');
  },
  'tool.started': (harness) => {
    expect(harness.toolActivity).toEqual([{ ...toolFrame, status: 'started' }]);
  },
  'tool.progress': (harness) => {
    expect(harness.toolActivity).toEqual([
      { ...toolFrame, status: 'progress', percent: 50, message: 'halfway' },
    ]);
  },
  'tool.error': (harness) => {
    expect(harness.toolActivity).toEqual([{ ...toolFrame, status: 'error', error: 'failed' }]);
  },
  'tool.policy-denied': (harness) => {
    expect(harness.toolActivity).toEqual([
      { ...toolFrame, status: 'policy-denied', reason: 'not allowed' },
    ]);
  },
  'elicitation.requested': (harness) => {
    expect(harness.elicitations).toEqual([
      { status: 'requested', requestId: 'request-1', message: 'May I?' },
    ]);
  },
  'elicitation.resolved': (harness) => {
    expect(harness.elicitations).toEqual([
      { status: 'requested', requestId: 'request-1', message: 'May I?' },
      { status: 'resolved', requestId: 'request-1', accepted: true },
    ]);
  },
};

describe('every ChatStreamEvent type is reduced, ignored, or terminal', () => {
  for (const type of reducedTypes) {
    test(`reduces ${type}`, async () => {
      const harness = createFrameHarness({
        turns: [[...(preludes[type] ?? []), frames[type], abortedFrame()]],
      });
      expect(await harness.send()).toBeUndefined();
      observations[type](harness);
      // The closing terminal is expected and outside every assertion above.
      expect(harness.aborted).toHaveLength(1);
      expect(harness.errors).toEqual([]);
    });
  }

  for (const type of IGNORED_STREAM_EVENT_TYPES) {
    test(`ignores ${type} without observable effect`, async () => {
      const harness = createFrameHarness({ turns: [[frames[type], abortedFrame()]] });
      expect(await harness.send()).toBeUndefined();
      expect(harness.toolActivity).toEqual([]);
      expect(harness.elicitations).toEqual([]);
      expect(harness.toolResults).toEqual([]);
      expect(harness.errors).toEqual([]);
    });
  }

  test('run.completed reconciles history to the frame conversation', async () => {
    const harness = createFrameHarness({ turns: [[frames['run.completed']]] });
    expect(await harness.send()).toBeUndefined();
    expect(harness.errors).toEqual([]);
    expect(harness.aborted).toEqual([]);
  });

  for (const type of ['run.error', 'run.tripwire'] as const) {
    test(`${type} rejects with ChatRunFailureError and reports once`, async () => {
      const harness = createFrameHarness({ turns: [[frames[type]]] });
      expect(await harness.send()).toBeInstanceOf(ChatRunFailureError);
      expect(harness.errors).toHaveLength(1);
    });
  }

  test('run.aborted notifies onRunAborted once with the frame reason', async () => {
    const harness = createFrameHarness({ turns: [[frames['run.aborted']]] });
    expect(await harness.send()).toBeUndefined();
    expect(harness.aborted).toEqual([{ reason: 'user' }]);
  });
});
