import { describe, expect, test } from 'bun:test';
import { createConversationHistory } from '../components/chat/builders.ts';
import { consumeSessionEvents } from './session-controller-events.ts';
import {
  abortedFrame,
  createFrameHarness,
  rolesOf,
  type FrameInput,
} from './session-controller-frame-test-support.ts';
import type { TurnState } from './session-controller-run.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

const runStarted = (runId: string): FrameInput => ({ type: 'run.started', runId });

function createTurnState(): TurnState {
  const conversation = createConversationHistory({ id: 'turn' });
  return {
    runId: undefined,
    text: '',
    currentAssistantText: '',
    currentAssistantMessageId: 'placeholder',
    currentStep: -1,
    legacyTextSeen: false,
    richTextSeen: false,
    toolResultSeen: false,
    approvalRequired: false,
    committed: conversation,
    toolCalls: new Set(),
    toolResults: new Set(),
    toolActivity: new Map(),
    settledEarly: new Set(),
    runAborted: undefined,
    terminalConversation: undefined,
    provisionalIds: new Set(),
    runStartIds: new Set(),
  };
}

async function* framesOf(frames: ChatStreamEvent[]): AsyncGenerator<ChatStreamEvent> {
  for (const frame of frames) yield frame;
}

/** Reduces frames directly and records what `state.runId` was at each side effect. */
async function reduce(frames: ChatStreamEvent[]) {
  const state = createTurnState();
  const runIdAtWrite: Array<string | undefined> = [];
  await consumeSessionEvents({
    events: framesOf(frames),
    controller: new AbortController(),
    userMessageId: 'user',
    state,
    options: {
      executionOwner: 'server',
      getConversation: () => createConversationHistory({ id: 'turn' }),
      setConversation: () => {},
      transport: () => framesOf([]),
    },
    emit: () => runIdAtWrite.push(state.runId),
    update: () => runIdAtWrite.push(state.runId),
    toolOwners: new Map(),
    pendingApprovals: new Set(),
    elicitations: new Map(),
    reportError: () => {},
    isCurrent: () => true,
    isProtocolFailure: () => false,
    markProtocolFailure: () => {},
  });
  return { state, runIdAtWrite };
}

describe('run.started reduction', () => {
  test('records the run identity in turn state', async () => {
    const { state } = await reduce([
      { type: 'run.started', runId: 'run-7', wireVersion: 3, sequence: 0 },
    ]);
    expect(state.runId).toBe('run-7');
  });

  test('records the identity before any other frame is reduced', async () => {
    const { runIdAtWrite } = await reduce([
      { type: 'run.started', runId: 'run-7', wireVersion: 3, sequence: 0 },
      {
        type: 'assistant.step.started',
        step: 0,
        messageId: 'host-0',
        wireVersion: 3,
        sequence: 1,
      },
      {
        type: 'stream:text-delta',
        content: 'hi',
        accumulated: 'hi',
        messageId: 'host-0',
        wireVersion: 3,
        sequence: 2,
      },
    ]);
    // The step and the delta each write to the conversation, and each of those
    // writes already sees the run identity.
    expect(runIdAtWrite.length).toBeGreaterThan(0);
    expect(runIdAtWrite.every((runId) => runId === 'run-7')).toBe(true);
  });

  test('keeps the first identity when a run repeats the frame', async () => {
    const { state } = await reduce([
      { type: 'run.started', runId: 'run-7', wireVersion: 3, sequence: 0 },
      { type: 'run.started', runId: 'run-8', wireVersion: 3, sequence: 1 },
    ]);
    expect(state.runId).toBe('run-7');
  });

  test('leaves the identity unset for a stream that never starts a run', async () => {
    const { state } = await reduce([{ type: 'text', text: 'hi' }]);
    expect(state.runId).toBeUndefined();
  });
});

describe('a version 3 run through the session controller', () => {
  test('streams text addressed by message identity into one assistant row', async () => {
    const harness = createFrameHarness({
      turns: [
        [
          runStarted('run-1'),
          { type: 'assistant.step.started', step: 0, messageId: 'host-0' },
          { type: 'stream:text-delta', content: 'he', accumulated: 'he', messageId: 'host-0' },
          { type: 'stream:text-delta', content: 'llo', accumulated: 'hello', messageId: 'host-0' },
          { type: 'assistant.step.completed', step: 0, messageId: 'host-0' },
          abortedFrame(),
        ],
      ],
    });
    expect(await harness.send()).toBeUndefined();
    expect(harness.errors).toEqual([]);
    expect(rolesOf(harness.conversation)).toEqual(['user', 'assistant']);
    expect(harness.conversation.messages['host-0']?.content).toBe('hello');
  });

  test('leaves the transcript as it is without the run frame', async () => {
    const withStart = createFrameHarness({
      turns: [[runStarted('run-1'), abortedFrame()]],
    });
    const control = createFrameHarness({ turns: [[abortedFrame()]] });
    await withStart.send();
    await control.send();
    expect(rolesOf(withStart.conversation)).toEqual(rolesOf(control.conversation));
  });
});
