/**
 * The rows a person's answers become. The page reads the Bureau's rendering of a delivered signal
 * (`renderSignalContinuation`) back as the text that was typed, and the tests here pin the form it
 * reads to the function that writes it, so the two cannot drift apart unseen.
 */
import { createConversationHistory } from '@lostgradient/chat';
import {
  buildSignalContinuationInput,
  renderSignalContinuation,
  signalMessageIdentifier,
} from '@lostgradient/operative';
import { describe, expect, test } from 'bun:test';

import { typedAnswerOf, withTypedAnswers } from './answer-rows.ts';

const DELIVERED_AT = '2026-10-21T00:00:00.000Z';

/** The body the Bureau renders for `payload` delivered on `signalName`, and the id of the row it is. */
function delivered(payload: unknown, signalName = 'environment') {
  return {
    id: signalMessageIdentifier('run-1', signalName, 0) ?? '',
    content: renderSignalContinuation(
      buildSignalContinuationInput(signalName, payload, DELIVERED_AT),
    ),
  };
}

describe('the text a delivered answer is shown as', () => {
  test('is what was typed, for a string payload', () => {
    const row = delivered('staging');

    expect(row.content).toBe('[signal:environment] "staging"');
    expect(typedAnswerOf(row.id, row.content)).toBe('staging');
  });

  test('keeps quotes, line breaks, and brackets in what was typed', () => {
    const typed = 'He said "yes"\n[signal:environment] "no"\\';
    const row = delivered(typed);

    expect(typedAnswerOf(row.id, row.content)).toBe(typed);
  });

  test('is the rendering itself for a payload that is not a string', () => {
    for (const payload of [{ environment: 'staging' }, ['staging'], 42, null, true]) {
      const row = delivered(payload);

      expect(typedAnswerOf(row.id, row.content)).toBeUndefined();
    }
  });

  test('is the rendering itself for a rejection, and for a denial with or without a reason', () => {
    const rejected = delivered({ __abRejected: true, reason: 'Not this one' });
    const denied = delivered({ __abDenied: true, reason: 'Too risky' });
    const deniedPlainly = delivered({ __abDenied: true });

    expect(rejected.content).toBe('[signal:environment] rejected: Not this one');
    expect(denied.content).toBe('[signal:environment] denied: Too risky');
    expect(deniedPlainly.content).toBe('[signal:environment] denied');
    for (const row of [rejected, denied, deniedPlainly]) {
      expect(typedAnswerOf(row.id, row.content)).toBeUndefined();
    }
  });

  test('is the rendering itself for a row whose id is not a delivery’s, whatever its text says', () => {
    const { content } = delivered('staging');

    for (const id of [
      'user-1',
      'run-1:step:0',
      'run-1:signal:environment',
      'run-1:signal:environment:x',
    ]) {
      expect(typedAnswerOf(id, content)).toBeUndefined();
    }
  });

  test('is the rendering itself when the id names a different signal than the text does', () => {
    const { content } = delivered('staging', 'region');

    expect(typedAnswerOf('run-1:signal:environment:0', content)).toBeUndefined();
  });

  test('is read for a signal whose name has colons in it', () => {
    const row = delivered('eu', 'ask:region');

    expect(typedAnswerOf(row.id, row.content)).toBe('eu');
  });
});

describe('a conversation with answers in it', () => {
  test('shows each delivered answer as typed, and every other row as it is', () => {
    const answer = delivered('staging');
    const denial = delivered({ __abDenied: true }, 'region');
    let conversation = createConversationHistory({ id: 'thread-1' });
    conversation = {
      ...conversation,
      ids: ['user-1', answer.id, denial.id],
      messages: {
        'user-1': { ...message('user-1', 'Ship it') },
        [answer.id]: { ...message(answer.id, answer.content) },
        [denial.id]: { ...message(denial.id, denial.content) },
      },
    };

    const shown = withTypedAnswers(conversation);

    expect(shown.ids.map((id) => shown.messages[id]?.content)).toEqual([
      'Ship it',
      'staging',
      '[signal:region] denied',
    ]);
    expect(withTypedAnswers(shown)).toBe(shown);
  });
});

function message(id: string, content: string) {
  return {
    id,
    role: 'user' as const,
    content,
    position: 0,
    createdAt: '2026-10-21T00:00:00.000Z',
    metadata: {},
    hidden: false,
    toolCall: undefined,
    toolResult: undefined,
    tokenUsage: undefined,
    cacheBoundary: undefined,
  };
}
