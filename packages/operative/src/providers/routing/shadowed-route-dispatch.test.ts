import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createRoutingGenerate } from './create-routing-generate';

/**
 * COR-716 — the documented contract is that the last route with a given name
 * wins (`routeMap`). The media filter builds its candidates from that map, so a
 * shadowed earlier route can never be dispatched to.
 */
describe('a duplicate route name dispatches to the route the map keeps', () => {
  it('a text-only call reaches the last route of a repeated name, as before media filtering', async () => {
    const generate = createRoutingGenerate({
      routes: [
        { name: 'fast', generate: async () => ({ content: 'shadowed-response', toolCalls: [] }) },
        { name: 'fast', generate: async () => ({ content: 'winning-response', toolCalls: [] }) },
      ],
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });
    const conversation = new Conversation();
    conversation.appendUserMessage('hello');
    const response = await generate({ conversation, step: 0, toolbox: createToolbox([]) });
    expect(response.content).toBe('winning-response');
  });
});
