/**
 * The message Home hands to the new chat it opens: for the agent it names, taken once, trimmed, and
 * stale after a few seconds, so it never rides in an address and never outlives its navigation.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  HANDOFF_WINDOW_MILLISECONDS,
  handOffFirstMessage,
  takeFirstMessage,
} from './new-chat-handoff.ts';

afterEach(() => {
  // Whatever a test left waiting is taken, so the next starts with none.
  takeFirstMessage('assistant');
  takeFirstMessage('echo');
});

describe('the first message handed to a new chat', () => {
  test('is taken once, trimmed, by the chat with the agent it was handed for', () => {
    handOffFirstMessage('assistant', '  What did I approve yesterday?  ');
    expect(takeFirstMessage('assistant')).toBe('What did I approve yesterday?');
    expect(takeFirstMessage('assistant')).toBeUndefined();
  });

  test('is left for the chat it is for, and not given to a chat with another agent', () => {
    handOffFirstMessage('assistant', 'Hello');
    expect(takeFirstMessage('echo')).toBeUndefined();
    expect(takeFirstMessage('assistant')).toBe('Hello');
  });

  test('hands nothing when it is blank, and a second handoff replaces the first', () => {
    handOffFirstMessage('assistant', '   \n ');
    expect(takeFirstMessage('assistant')).toBeUndefined();
    handOffFirstMessage('assistant', 'first');
    handOffFirstMessage('assistant', 'second');
    expect(takeFirstMessage('assistant')).toBe('second');
  });

  test('goes stale, so a chat opened by hand later never sends what was typed earlier', () => {
    const now = performance.now.bind(performance);
    handOffFirstMessage('assistant', 'Hello');
    try {
      performance.now = () => now() + HANDOFF_WINDOW_MILLISECONDS + 1;
      expect(takeFirstMessage('assistant')).toBeUndefined();
    } finally {
      performance.now = now;
    }
    // A stale handoff is dropped, not kept for later.
    expect(takeFirstMessage('assistant')).toBeUndefined();
  });
});
