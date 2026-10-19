import { afterEach, describe, expect, test } from 'bun:test';

import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { chatHomePath } from './chat-home.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const answering = (contexts: unknown[]) => {
  const calls: unknown[] = [];
  restore = installFetchImplementation(async (_input, init) => {
    calls.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    return Response.json({ jsonrpc: '2.0', id: 1, result: { contexts, nextOffset: null } });
  });
  return calls;
};

const context = (id: string) => ({
  id,
  owner: 'anonymous:local',
  agentName: 'assistant',
  title: null,
  lastMessagePreview: null,
  messageCount: 1,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  activity: 'idle',
});

describe('where / goes', () => {
  test('is the session updated most recently, which the Bureau lists first', async () => {
    const calls = answering([context('newest session')]);

    expect(await chatHomePath()).toBe('/chat/newest%20session');
    expect(calls[0]).toMatchObject({ method: 'bureau.contexts.list', params: { limit: 1 } });
  });

  test('is the chat list when there is no session', async () => {
    answering([]);

    expect(await chatHomePath()).toBe('/chat');
  });
});
