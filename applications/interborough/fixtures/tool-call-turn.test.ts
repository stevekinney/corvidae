/**
 * Contract tests for `fixtures/tool-call-turn.ts`: the thirty-call turn the long-turn capture
 * (`tests/e2e/chat-tool-call-turn.spec.ts`) answers the Bureau with. The capture's assertions read
 * the page, so these say what the data holds: thirty calls, one failed, one approved after the
 * fact, one waiting, and the eighteen seconds the turn's summary line ends with.
 */
import { describe, expect, test } from 'bun:test';

import {
  TOOL_CALL_TURN_CALLS,
  TOOL_CALL_TURN_QUESTION,
  TOOL_CALL_TURN_SECONDS,
  TOOL_CALL_TURN_THREAD,
  TOOL_CALL_TURN_TITLE,
  toolCallTurnContext,
  toolCallTurnMessages,
} from './tool-call-turn.ts';

type Message = Record<string, unknown>;

const messages = toolCallTurnMessages();
const results = messages.filter((message) => message['role'] === 'tool');
const outcomeOf = (message: Message): string => {
  const metadata = message['metadata'] as Record<string, { outcome: string }>;
  return metadata['conversationalist:toolResult']?.outcome ?? '';
};

describe('the long turn’s thread', () => {
  test('is one message from the person, then thirty calls each with an answer', () => {
    expect(messages[0]).toMatchObject({ role: 'user' });
    const calls = messages.flatMap((message) =>
      Array.isArray(message['toolCalls']) ? (message['toolCalls'] as Message[]) : [],
    );
    expect(calls).toHaveLength(TOOL_CALL_TURN_CALLS);
    expect(new Set(calls.map((call) => call['id'])).size).toBe(TOOL_CALL_TURN_CALLS);
    expect(results).toHaveLength(TOOL_CALL_TURN_CALLS);
    expect(results.map((result) => result['toolCallId'])).toEqual(
      expect.arrayContaining(calls.map((call) => call['id'])),
    );
  });

  test('has one call that failed, one approved after the person decided, and one that waits', () => {
    const outcomes = results.map(outcomeOf);
    expect(outcomes.filter((outcome) => outcome === 'error')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'action_required')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'success')).toHaveLength(28);
    const approved = results.filter((result) =>
      Object.hasOwn(result['metadata'] as object, 'approvalDecision'),
    );
    expect(approved).toHaveLength(1);
    const waiting = results.at(-1) as Message;
    expect(outcomeOf(waiting)).toBe('action_required');
    expect(JSON.stringify(waiting)).toContain(TOOL_CALL_TURN_QUESTION);
    // The turn ends on the call that waits, as the board's does.
    expect(messages.at(-1)).toBe(waiting);
  });

  test('records when each call ran, and the turn spent eighteen seconds on its tools', () => {
    const intervals = results
      .map(
        (result) =>
          (result['metadata'] as { toolTiming?: { startedAt: string; endedAt: string } })
            .toolTiming,
      )
      .filter((timing) => timing !== undefined)
      .map((timing) => ({ start: Date.parse(timing.startedAt), end: Date.parse(timing.endedAt) }))
      .toSorted((left, right) => left.start - right.start);
    // The call that waits has none; every other call does.
    expect(intervals).toHaveLength(TOOL_CALL_TURN_CALLS - 1);
    let total = 0;
    let reach = -Infinity;
    for (const { start, end } of intervals) {
      total += Math.max(0, end - Math.max(start, reach));
      reach = Math.max(reach, end);
    }
    expect(total).toBe(TOOL_CALL_TURN_SECONDS * 1000);
    // Some calls ran together: the calls add up to more than the time they took.
    const summed = intervals.reduce((sum, { start, end }) => sum + (end - start), 0);
    expect(summed).toBeGreaterThan(total);
  });
});

describe('the long turn’s chat record', () => {
  test('is listed under 9:52 AM Central time as a chat that waits on the person', () => {
    const context = toolCallTurnContext({ agentName: 'tool-runner', model: null });
    expect(context).toMatchObject({
      id: TOOL_CALL_TURN_THREAD,
      title: TOOL_CALL_TURN_TITLE,
      agentName: 'tool-runner',
      activity: 'awaiting-input',
      lastMessagePreview: TOOL_CALL_TURN_QUESTION,
      messageCount: messages.length,
      updatedAt: '2026-11-02T15:52:21.000Z',
    });
  });
});
