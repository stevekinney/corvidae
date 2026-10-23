/**
 * COR-1645 — a session records what started it. A goal and a schedule's fire write their origin
 * when they create the session; a person's chat writes nothing, so a session with no origin is a
 * chat and an index written before origins existed needs no migration. The store lists by origin
 * before it pages, so a page of chats is full of chats however many fires came after them.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createSessionStore } from './create-session-store';
import {
  DEFAULT_SESSION_ORIGIN,
  SESSION_ORIGIN_METADATA_KEY,
  SESSION_ORIGINS,
  sessionOriginOf,
} from './session-origin';

function sessionWith(id: string, metadata: Record<string, string | number>) {
  return createAgentSession({
    id,
    agentName: 'origin-agent',
    conversationHistory: createConversationHistory(),
    metadata,
    runs: [],
  });
}

describe('the origin a session’s metadata records', () => {
  it('reads each origin from the reserved key', () => {
    for (const origin of SESSION_ORIGINS) {
      expect(sessionOriginOf({ [SESSION_ORIGIN_METADATA_KEY]: origin })).toBe(origin);
    }
  });

  it('reads a chat for a session that records none', () => {
    expect(DEFAULT_SESSION_ORIGIN).toBe('chat');
    expect(sessionOriginOf({})).toBe('chat');
  });

  it('reads a chat for a value that is not an origin, so a corrupt record is not hidden', () => {
    expect(sessionOriginOf({ [SESSION_ORIGIN_METADATA_KEY]: 'cron' })).toBe('chat');
    expect(sessionOriginOf({ [SESSION_ORIGIN_METADATA_KEY]: 7 })).toBe('chat');
    expect(sessionOriginOf({ [SESSION_ORIGIN_METADATA_KEY]: ['goal'] })).toBe('chat');
  });
});

describe('listing sessions by origin', () => {
  async function seededStore() {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(sessionWith('old-chat', {}));
    await store.save(sessionWith('goal-1', { [SESSION_ORIGIN_METADATA_KEY]: 'goal' }));
    await store.save(sessionWith('fire-1', { [SESSION_ORIGIN_METADATA_KEY]: 'schedule' }));
    await store.save(sessionWith('new-chat', {}));
    return store;
  }

  it('lists only chats, a session with no origin among them', async () => {
    const store = await seededStore();

    const rows = await store.list({ origin: 'chat' });

    expect(rows.map((row) => row.id).toSorted()).toEqual(['new-chat', 'old-chat']);
  });

  it('lists only the sessions a goal or a schedule started', async () => {
    const store = await seededStore();

    const goals = await store.list({ origin: 'goal' });
    const fires = await store.list({ origin: 'schedule' });

    expect(goals.map((row) => row.id)).toEqual(['goal-1']);
    expect(fires.map((row) => row.id)).toEqual(['fire-1']);
  });

  it('lists every session when no origin is asked for', async () => {
    const store = await seededStore();

    expect(await store.list()).toHaveLength(4);
  });

  it('filters before it pages, so a page of chats is full of chats', async () => {
    const store = await seededStore();

    const first = await store.list({ origin: 'chat', limit: 1 });
    const second = await store.list({ origin: 'chat', limit: 1, offset: 1 });
    const third = await store.list({ origin: 'chat', limit: 1, offset: 2 });

    // Two goal and schedule sessions sit among the four, and neither takes a page.
    expect([...first, ...second].map((row) => row.id).toSorted()).toEqual(['new-chat', 'old-chat']);
    expect(third).toEqual([]);
  });
});
