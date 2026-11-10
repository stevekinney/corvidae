import { describe, expect, test } from 'bun:test';

import { newChatFromWorkflowsPath, startedFromWorkflows } from './new-chat-address.ts';

describe('a new chat started from Workflows', () => {
  test('is addressed by where it came from and nothing to send', () => {
    const path = newChatFromWorkflowsPath();
    expect(path).toBe('/chats/new?from=workflows');
    const search = new URL(path, 'http://host').searchParams;
    expect(startedFromWorkflows(search)).toBe(true);
    expect([...search.keys()]).toEqual(['from']);
  });

  test('is not any other address', () => {
    expect(startedFromWorkflows(new URLSearchParams())).toBe(false);
    expect(startedFromWorkflows(new URLSearchParams({ from: 'schedules' }))).toBe(false);
    expect(startedFromWorkflows(new URLSearchParams({ agent: 'workflow-author' }))).toBe(false);
  });
});
