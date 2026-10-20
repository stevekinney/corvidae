import { describe, expect, test } from 'bun:test';

import type { AgentSummary, ChatContext } from '../../lib/bureau-client.ts';
import { agentsByName, sessionSummary } from './session-summary.ts';

const context: ChatContext = {
  id: 'session-1',
  owner: 'anonymous:local',
  agentName: 'assistant',
  title: 'Plan the week',
  lastMessagePreview: 'Sounds good.',
  messageCount: 4,
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T09:00:00.000Z',
  activity: 'running',
};

const agent: AgentSummary = {
  name: 'assistant',
  displayName: 'Assistant',
  description: null,
  definitionRevision: 1,
  kind: 'code',
  publishState: 'published',
  media: null,
};

describe('a session as a row of the list', () => {
  test('takes its identifier, times, count, title, preview and activity from the summary', () => {
    const row = sessionSummary(context, agentsByName([agent]));

    expect(row).toMatchObject({
      id: 'session-1',
      title: 'Plan the week',
      messageCount: 4,
      createdAt: context.createdAt,
      updatedAt: context.updatedAt,
      lastMessageText: 'Sounds good.',
      activity: 'running',
      status: 'active',
      unreadCount: 0,
    });
  });

  test('names the agent by its identifier and the display name the agent list gives', () => {
    const row = sessionSummary(context, agentsByName([agent]));

    expect(row.agent).toEqual({ id: 'assistant', name: 'Assistant' });
    expect(row.participantNames).toEqual(['Assistant']);
  });

  test('falls back to the identifier for an agent the list does not hold', () => {
    const row = sessionSummary(context, agentsByName([]));

    expect(row.agent).toEqual({ id: 'assistant', name: 'assistant' });
  });

  test('is called New chat with no title, and has no preview when there is none', () => {
    const row = sessionSummary(
      { ...context, title: null, lastMessagePreview: null },
      agentsByName([agent]),
    );

    expect(row.title).toBe('New chat');
    expect('lastMessageText' in row).toBe(false);
  });
});
