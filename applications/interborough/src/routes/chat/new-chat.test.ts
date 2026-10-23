import { describe, expect, test } from 'bun:test';

import type { AgentSummary } from '../../lib/bureau-client.ts';
import { examplePrompts, MAXIMUM_EXAMPLE_PROMPTS, startableAgents } from './new-chat.ts';

const agent = (name: string, publishState: AgentSummary['publishState']): AgentSummary => ({
  name,
  displayName: name,
  description: null,
  definitionRevision: 1,
  kind: 'code',
  publishState,
  media: null,
});

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

describe('the agents a new chat offers', () => {
  test('are the published ones, in the Bureau’s order', () => {
    const offered = startableAgents([
      agent('one', 'published'),
      agent('two', 'withdrawn'),
      agent('three', 'unpublished'),
      agent('four', 'published'),
    ]);

    expect(offered.map((entry) => entry.name)).toEqual(['one', 'four']);
  });
});
