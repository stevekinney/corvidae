import { describe, expect, test } from 'bun:test';

import type { AgentSummary } from '../../lib/bureau-client.ts';
import { canChat, newChatPath, publishLabel } from './agent-presentation.ts';

const agent = (publishState: AgentSummary['publishState']): AgentSummary => ({
  name: 'research bot',
  displayName: 'Research bot',
  description: null,
  definitionRevision: 1,
  kind: 'file',
  publishState,
  media: null,
});

describe('an agent as the agents views show it', () => {
  test('can be chatted with only when it is published', () => {
    expect(canChat(agent('published'))).toBe(true);
    expect(canChat(agent('withdrawn'))).toBe(false);
    expect(canChat(agent('unpublished'))).toBe(false);
  });

  test('says whether it is published', () => {
    expect(publishLabel(agent('published'))).toBe('Published');
    expect(publishLabel(agent('withdrawn'))).toBe('Not published');
    expect(publishLabel(agent('unpublished'))).toBe('Not published');
  });

  test('opens a new chat at an address that names it, encoded', () => {
    expect(newChatPath('research bot')).toBe('/chat/new?agent=research%20bot');
  });
});
