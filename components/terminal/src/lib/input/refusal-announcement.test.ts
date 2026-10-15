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

  test('refusals of one reason from different sources share one announcement text per source', () => {
    const { messages, refused } = announcer();
    refused({ reason: 'paused' });
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
