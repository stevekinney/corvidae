/**
 * COR-2285 — a person can archive a session. When it was archived is stored in the session's
 * metadata, so a session written before archiving existed reads as not archived, a malformed value
 * reads as not archived, and the store filters by it before it pages.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createSessionStore, summarizeSession } from './create-session-store';
import { SESSION_ARCHIVED_AT_METADATA_KEY, sessionArchivedAtOf } from './session-archive';

const ARCHIVED_AT = '2026-11-13T10:00:00.000Z';

function sessionOf(id: string, metadata: Record<string, string> = {}) {
  const conversation = new Conversation(createConversationHistory());
  conversation.appendMessages({ role: 'user', content: `message of ${id}` });
  return createAgentSession({
    id,
    agentName: 'archive-agent',
    conversationHistory: conversation.current,
    metadata,
    runs: [],
  });
}

describe('when a session’s metadata says it was archived', () => {
  it('reads the stored timestamp', () => {
    expect(sessionArchivedAtOf({ [SESSION_ARCHIVED_AT_METADATA_KEY]: ARCHIVED_AT })).toBe(
      ARCHIVED_AT,
    );
  });

  it('reads not archived for a session that records nothing, as every older session does', () => {
    expect(sessionArchivedAtOf({})).toBeNull();
  });

  it('reads not archived for a value that is not a timestamp', () => {
    for (const stored of [7, '', '   ', 'yesterday', ['x'], null, true, { at: ARCHIVED_AT }]) {
      const metadata = { [SESSION_ARCHIVED_AT_METADATA_KEY]: stored } as never;
      expect(sessionArchivedAtOf(metadata)).toBeNull();
    }
  });

  it('reads not archived for a key the metadata only inherits', () => {
    const inherited = Object.create({ [SESSION_ARCHIVED_AT_METADATA_KEY]: ARCHIVED_AT }) as never;
    expect(sessionArchivedAtOf(inherited)).toBeNull();
  });

  it('is carried by the summary’s metadata, so the summary index needs no new field', () => {
    const summary = summarizeSession(
      sessionOf('a', { [SESSION_ARCHIVED_AT_METADATA_KEY]: ARCHIVED_AT }),
    );
    expect(sessionArchivedAtOf(summary.metadata)).toBe(ARCHIVED_AT);
    expect(Object.keys(summary)).not.toContain('archivedAt');
  });
});

describe('listing sessions by whether they are archived', () => {
  async function seededStore() {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(sessionOf('a'));
    await store.save(sessionOf('b', { [SESSION_ARCHIVED_AT_METADATA_KEY]: ARCHIVED_AT }));
    await store.save(sessionOf('c'));
    await store.save(sessionOf('d', { [SESSION_ARCHIVED_AT_METADATA_KEY]: ARCHIVED_AT }));
    await store.save(sessionOf('e', { [SESSION_ARCHIVED_AT_METADATA_KEY]: 'not a time' }));
    return store;
  }

  const idsOf = (rows: readonly { id: string }[]) => rows.map((row) => row.id).toSorted();

  it('keeps every session by default and for include', async () => {
    const store = await seededStore();

    expect(idsOf(await store.list())).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(idsOf(await store.list({ archived: 'include' }))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps only the sessions that are not archived for exclude, a malformed value among them', async () => {
    const store = await seededStore();

    expect(idsOf(await store.list({ archived: 'exclude' }))).toEqual(['a', 'c', 'e']);
  });

  it('keeps only the archived sessions for only', async () => {
    const store = await seededStore();

    expect(idsOf(await store.list({ archived: 'only' }))).toEqual(['b', 'd']);
  });

  it('filters before it pages, so every page is full of matches', async () => {
    const store = await seededStore();

    const first = await store.list({ archived: 'exclude', limit: 2 });
    const second = await store.list({ archived: 'exclude', limit: 2, offset: 2 });

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(idsOf([...first, ...second])).toEqual(['a', 'c', 'e']);
  });
});
