import { describe, expect, test } from 'bun:test';

import type { InputRefusal, InputRefusalReason } from './input-types.ts';
import { createRefusalAnnouncer } from './refusal-announcement.ts';

function announcer() {
  const messages: string[] = [];
  const refusals = createRefusalAnnouncer((message) => messages.push(message));
  return { messages, ...refusals };
}

describe('which refusals are announced', () => {
  const announced: InputRefusalReason[] = [
    'paused',
    'unknown-delivery',
    'frozen',
    'oversized',
    'closed',
    'malformed',
    'hook-failed',
  ];

  test.each(announced)('a refusal for %s is announced, with its own wording', (reason) => {
    const { messages, refused } = announcer();
    refused({ reason });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/\S/);
  });

  test('every announced reason reads differently from the others', () => {
    const { messages, refused } = announcer();
    for (const reason of announced) refused({ reason });
    expect(new Set(messages).size).toBe(announced.length);
  });

  test('a read-only keystroke is never announced', () => {
    const { messages, refused } = announcer();
    refused({ reason: 'read-only' });
    expect(messages).toEqual([]);
  });

  test.each(['paste', 'interrupt'] as const)(
    'a read-only refusal of a deliberate %s is announced',
    (source) => {
      const { messages, refused } = announcer();
      refused({ reason: 'read-only', source });
      expect(messages).toEqual(['The terminal is read-only. Nothing was sent.']);
    },
  );
});

describe('repeats', () => {
  test('the same refusal repeated is announced once', () => {
    const { messages, refused } = announcer();
    const refusal: InputRefusal = { reason: 'frozen' };
    for (let count = 0; count < 20; count += 1) refused(refusal);
    expect(messages).toHaveLength(1);
  });

  test('a different refusal in between lets the first be announced again', () => {
    const { messages, refused } = announcer();
    refused({ reason: 'frozen' });
    refused({ reason: 'oversized' });
    refused({ reason: 'frozen' });
    expect(messages).toHaveLength(3);
  });

  test.each(['paste', 'interrupt'] as const)(
    'a deliberate %s refused twice in a row is announced both times',
    (source) => {
      const { messages, refused } = announcer();
      refused({ reason: 'oversized', source });
      refused({ reason: 'oversized', source });
      expect(messages).toHaveLength(2);
    },
  );

  test('a read-only interrupt refused twice is announced both times', () => {
    const { messages, refused } = announcer();
    refused({ reason: 'read-only', source: 'interrupt' });
    refused({ reason: 'read-only', source: 'interrupt' });
    expect(messages).toHaveLength(2);
  });

  test('a keystroke repeating what a deliberate action just announced is not announced again', () => {
    const { messages, refused } = announcer();
    refused({ reason: 'paused', source: 'paste' });
    refused({ reason: 'paused', acceptedOperations: 0, totalOperations: 1 });
    expect(messages).toHaveLength(1);
  });

  test('resetting lets the same refusal be announced again', () => {
    const { messages, refused, reset } = announcer();
    refused({ reason: 'frozen' });
    reset();
    refused({ reason: 'frozen' });
    expect(messages).toHaveLength(2);
  });
});
