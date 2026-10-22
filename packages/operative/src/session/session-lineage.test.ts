/**
 * COR-1560 — a branched session records where it came from. Its owner, the session it was
 * branched from (`parentContextId`) and the message it was branched at (`forkedFromMessageId`)
 * are reserved metadata keys the summary index carries, so a listing shows them before the
 * session has a run. The summary index is at format version 3, and an index of any earlier version
 * is rebuilt from the bodies rather than refused.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createConversationHistory } from 'conversationalist';
import { describe, expect, it } from 'bun:test';

import { createAgentSession } from '../agent-session';
import { createSessionStore, summarizeSession } from './create-session-store';
import { createSessionHandle, ForkIdentifierInUseError } from './session-handle';
import { createTestRunOptions } from './session-handle-test-support';
import {
  SESSION_FORKED_FROM_MESSAGE_METADATA_KEY,
  SESSION_PARENT_METADATA_KEY,
  sessionLineageOf,
} from './session-lineage';
import { SESSION_OWNER_METADATA_KEY } from './session-owner';

const SUMMARY_INDEX_KEY = 'agent-session:summary-index';

function sessionWith(id: string, metadata: Record<string, never | string | number> = {}) {
  return createAgentSession({
    id,
    agentName: 'fork-agent',
    conversationHistory: createConversationHistory(),
    metadata: metadata as never,
    runs: [],
  });
}

describe('the lineage a session’s metadata records', () => {
  it('reads the parent and the message from the reserved keys', () => {
    expect(
      sessionLineageOf({
        [SESSION_PARENT_METADATA_KEY]: 'parent-1',
        [SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]: 'message-1',
      }),
    ).toEqual({ parentContextId: 'parent-1', forkedFromMessageId: 'message-1' });
  });

  it('reads null for a session that records none, and for a value that is not text', () => {
    expect(sessionLineageOf({})).toEqual({ parentContextId: null, forkedFromMessageId: null });
    expect(
      sessionLineageOf({
        [SESSION_PARENT_METADATA_KEY]: 7,
        [SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]: ['x'],
      }),
    ).toEqual({ parentContextId: null, forkedFromMessageId: null });
  });

  it('is part of a session summary', () => {
    const summary = summarizeSession(
      sessionWith('child', {
        [SESSION_PARENT_METADATA_KEY]: 'parent-1',
        [SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]: 'message-1',
      }),
    );

    expect(summary.parentContextId).toBe('parent-1');
    expect(summary.forkedFromMessageId).toBe('message-1');
    expect(summarizeSession(sessionWith('root')).parentContextId).toBeNull();
    expect(summarizeSession(sessionWith('root')).forkedFromMessageId).toBeNull();
  });
});

describe('the summary index at format version 3', () => {
  it('lists a branched session’s lineage, owner included, before it has a run', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(
      sessionWith('child', {
        [SESSION_OWNER_METADATA_KEY]: 'alice',
        [SESSION_PARENT_METADATA_KEY]: 'parent-1',
        [SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]: 'message-1',
      }),
    );

    const [row] = await store.list({ owner: 'alice' });

    expect(row).toMatchObject({
      id: 'child',
      owner: 'alice',
      parentContextId: 'parent-1',
      forkedFromMessageId: 'message-1',
    });
  });

  it('is written at version 3', async () => {
    const backing = textValueStore(new MemoryStorage());
    const store = createSessionStore(backing);
    await store.save(sessionWith('root'));

    const index = JSON.parse((await backing.get(SUMMARY_INDEX_KEY))!) as {
      formatVersion: number;
      summaries: Record<string, Record<string, unknown>>;
    };

    expect(index.formatVersion).toBe(3);
    expect(index.summaries['root']).toMatchObject({
      parentContextId: null,
      forkedFromMessageId: null,
    });
  });

  it('still reads a summary index written before it: it is rebuilt from the session bodies', async () => {
    const backing = textValueStore(new MemoryStorage());
    const store = createSessionStore(backing);
    await store.save(
      sessionWith('child', {
        [SESSION_OWNER_METADATA_KEY]: 'alice',
        [SESSION_PARENT_METADATA_KEY]: 'parent-1',
        [SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]: 'message-1',
      }),
    );
    await store.save(sessionWith('root', { [SESSION_OWNER_METADATA_KEY]: 'alice' }));
    // The index as it was written at version 2: no lineage fields on any row.
    await backing.set(
      SUMMARY_INDEX_KEY,
      JSON.stringify({
        formatVersion: 2,
        summaries: Object.fromEntries(
          ['child', 'root'].map((id) => [
            id,
            {
              id,
              agentName: 'fork-agent',
              title: null,
              lastMessagePreview: null,
              owner: 'alice',
              messageCount: 0,
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
              metadata: {},
            },
          ]),
        ),
      }),
    );

    const rows = await store.list({ owner: 'alice', sortBy: 'createdAt', sortOrder: 'asc' });

    expect(rows.map((row) => row.id).toSorted()).toEqual(['child', 'root']);
    expect(rows.find((row) => row.id === 'child')).toMatchObject({
      parentContextId: 'parent-1',
      forkedFromMessageId: 'message-1',
    });
    expect(rows.find((row) => row.id === 'root')).toMatchObject({
      parentContextId: null,
      forkedFromMessageId: null,
    });
    expect((JSON.parse((await backing.get(SUMMARY_INDEX_KEY))!) as { formatVersion: number }).formatVersion).toBe(
      3,
    );
  });
});

describe('session.fork() recording its lineage', () => {
  async function source() {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(sessionWith('source', { [SESSION_OWNER_METADATA_KEY]: 'alice' }));
    const handle = createSessionHandle('source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });
    return { store, handle };
  }

  it('records the parent and the message when the fork names the message it branches from', async () => {
    const { store, handle } = await source();

    const forked = await handle.fork({ forkedFromMessageId: 'message-1' });

    const session = await store.load(forked.id);
    expect(session?.metadata).toEqual({
      [SESSION_OWNER_METADATA_KEY]: 'alice',
      [SESSION_PARENT_METADATA_KEY]: 'source',
      [SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]: 'message-1',
    });
    const [row] = await store.list({ owner: 'alice', limit: 10 });
    expect((await store.list({ owner: 'alice' })).find((entry) => entry.id === forked.id)).toMatchObject(
      { parentContextId: 'source', forkedFromMessageId: 'message-1' },
    );
    expect(row).toBeDefined();
  });

  it('gives the fork the owner it is told, not the source’s', async () => {
    const { store, handle } = await source();

    const forked = await handle.fork({ forkedFromMessageId: 'message-1', owner: 'bob' });

    expect((await store.load(forked.id))?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('bob');
    expect((await store.list({ owner: 'bob' })).map((row) => row.id)).toEqual([forked.id]);
  });

  it('creates the fork under the identifier it is given', async () => {
    const { store, handle } = await source();

    const forked = await handle.fork({ forkedFromMessageId: 'message-1', id: 'planned-id' });

    expect(forked.id).toBe('planned-id');
    expect(await store.exists('planned-id')).toBe(true);
  });

  it('creates nothing more when the same fork is asked for again under the same identifier', async () => {
    const { store, handle } = await source();
    const options = { forkedFromMessageId: 'message-1', id: 'planned-id', owner: 'alice' };
    await handle.fork(options);
    const before = (await store.list({})).length;

    const again = await handle.fork(options);

    expect(again.id).toBe('planned-id');
    expect((await store.list({})).length).toBe(before);
  });

  it('refuses an identifier a different session already holds, and changes nothing', async () => {
    const { store, handle } = await source();
    await store.save(sessionWith('taken', { [SESSION_OWNER_METADATA_KEY]: 'alice' }));
    await handle.fork({ forkedFromMessageId: 'message-1', id: 'planned-id' });

    await expect(handle.fork({ forkedFromMessageId: 'message-1', id: 'taken' })).rejects.toBeInstanceOf(
      ForkIdentifierInUseError,
    );
    await expect(
      handle.fork({ forkedFromMessageId: 'message-2', id: 'planned-id' }),
    ).rejects.toBeInstanceOf(ForkIdentifierInUseError);
    expect((await store.load('planned-id'))?.metadata[SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]).toBe(
      'message-1',
    );
  });

  it('records no lineage for a fork that names no message, as before', async () => {
    const { store, handle } = await source();

    const forked = await handle.fork();

    expect((await store.load(forked.id))?.metadata).toEqual({ [SESSION_OWNER_METADATA_KEY]: 'alice' });
  });
});
