import { describe, expect, test } from 'bun:test';

import { examplePrompts, MAXIMUM_EXAMPLE_PROMPTS } from './new-chat.ts';

describe('the prompts an agent’s card offers', () => {
  test('are the agent’s own examples, trimmed, and none when it has none', () => {
    expect(examplePrompts({ examples: ['  Refund order 1234 ', 'Look up order 1001'] })).toEqual([
      'Refund order 1234',
      'Look up order 1001',
    ]);
    expect(examplePrompts({})).toEqual([]);
    expect(examplePrompts({ examples: [] })).toEqual([]);
  });

  test('leave out an empty prompt and stop at three', () => {
    expect(MAXIMUM_EXAMPLE_PROMPTS).toBe(3);
    expect(examplePrompts({ examples: ['a', ' ', '', 'b', 'c', 'd', 'e'] })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
