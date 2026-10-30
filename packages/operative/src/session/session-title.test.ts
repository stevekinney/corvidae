/**
 * COR-1909 — a person can give a session a title. It is stored in the session's metadata, so a
 * session written before renames existed reads as it always did, clearing it brings the derived
 * title back, and the store filters by title before it pages.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createSessionStore, summarizeSession } from './create-session-store';
import {
  SESSION_TITLE_METADATA_KEY,
  SESSION_TITLE_OVERRIDE_LIMIT,
  sessionTitleOverrideOf,
} from './session-title';

function sessionTitled(id: string, firstMessage: string, metadata: Record<string, string> = {}) {
  const conversation = new Conversation(createConversationHistory());
  conversation.appendMessages({ role: 'user', content: firstMessage });
  return createAgentSession({
    id,
    agentName: 'title-agent',
    conversationHistory: conversation.current,
    metadata,
    runs: [],
  });
}

describe('the title a session’s metadata records', () => {
  it('reads the stored title', () => {
    expect(sessionTitleOverrideOf({ [SESSION_TITLE_METADATA_KEY]: 'Trip plan' })).toBe('Trip plan');
    expect(SESSION_TITLE_OVERRIDE_LIMIT).toBeGreaterThan(80);
  });

  it('reads none for a session that records none, as every session written before renames did', () => {
    expect(sessionTitleOverrideOf({})).toBeNull();
    expect(summarizeSession(sessionTitled('old', 'derived title')).title).toBe('derived title');
  });

  it('reads none for a value that is not a title, so a corrupt record falls back to the derived one', () => {
    for (const stored of [7, '', '   ', ['x'], null]) {
      const metadata = { [SESSION_TITLE_METADATA_KEY]: stored } as never;
      expect(sessionTitleOverrideOf(metadata)).toBeNull();
    }
    const summary = summarizeSession(
      sessionTitled('corrupt', 'derived title', { [SESSION_TITLE_METADATA_KEY]: 7 as never }),
    );
    expect(summary.title).toBe('derived title');
  });
});

describe('the summary title', () => {
  it('is the stored title when one is recorded, over the first message', () => {
    const summary = summarizeSession(
      sessionTitled('renamed', 'derived title', { [SESSION_TITLE_METADATA_KEY]: 'Chosen' }),
    );

    expect(summary.title).toBe('Chosen');
  });

  it('returns to the derived title once the stored one is cleared, in the index too', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(sessionTitled('s1', 'derived title'));

    await store.updateMetadata('s1', { [SESSION_TITLE_METADATA_KEY]: 'Chosen' });
    const renamed = await store.list();
    expect(renamed.map((row) => row.title)).toEqual(['Chosen']);

    await store.update(
      's1',
      (session) => {
        if (session === undefined) return undefined;
        const { [SESSION_TITLE_METADATA_KEY]: _cleared, ...rest } = session.metadata;
        return { ...session, metadata: rest };
      },
      { refreshActivity: false },
    );
    const cleared = await store.list();
    expect(cleared.map((row) => row.title)).toEqual(['derived title']);
  });
});

describe('listing sessions by title', () => {
  async function seededStore() {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(sessionTitled('a', 'Plan the Trip'));
    await store.save(sessionTitled('b', 'Fix the build'));
    await store.save(
      sessionTitled('c', 'unrelated', { [SESSION_TITLE_METADATA_KEY]: 'TRIP notes' }),
    );
    await store.save(sessionTitled('d', 'another trip home'));
    return store;
  }

  it('matches a substring of the title, ignoring case, and the stored title counts', async () => {
    const store = await seededStore();

    const rows = await store.list({ titleContains: 'trip' });

    expect(rows.map((row) => row.id).toSorted()).toEqual(['a', 'c', 'd']);
  });

  it('matches nothing the title does not hold, even a message the title is cut from', async () => {
    const store = await seededStore();

    expect(await store.list({ titleContains: 'unrelated' })).toEqual([]);
    expect(await store.list({ titleContains: 'zebra' })).toEqual([]);
  });

  it('filters before it pages, so every page is full of matches', async () => {
    const store = await seededStore();

    const first = await store.list({ titleContains: 'trip', limit: 2 });
    const second = await store.list({ titleContains: 'trip', limit: 2, offset: 2 });

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect([...first, ...second].map((row) => row.id).toSorted()).toEqual(['a', 'c', 'd']);
  });

  it('lists every session when no title is asked for', async () => {
    const store = await seededStore();

    expect(await store.list()).toHaveLength(4);
  });
});
