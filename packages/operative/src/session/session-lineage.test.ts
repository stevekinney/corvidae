/**
 * COR-1560 — a branched session records where it came from. Its owner, the session it was
 * branched from (`parentContextId`) and the message it was branched at (`forkedFromMessageId`)
 * are reserved metadata keys the summary index carries, so a listing shows them before the
 * session has a run. The summary index is at format version 3, and an index of any earlier version
 * is rebuilt from the bodies rather than refused.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createAgentSession } from '../agent-session';
import { createSessionStore, summarizeSession } from './create-session-store';
import {
  createSessionHandle,
  ForkIdentifierInUseError,
  ForkThroughMessageError,
} from './session-handle';
import { createTestRunOptions } from './session-handle-test-support';
import {
  SESSION_FORKED_FROM_MESSAGE_METADATA_KEY,
  SESSION_PARENT_METADATA_KEY,
  sessionLineageOf,
} from './session-lineage';
import { SESSION_OWNER_METADATA_KEY } from './session-owner';

const SUMMARY_INDEX_KEY = 'agent-session:summary-index';

function sessionWith(id: string, metadata: Record<string, string | number> = {}) {
  return createAgentSession({
    id,
    agentName: 'fork-agent',
    conversationHistory: createConversationHistory(),
    metadata: metadata,
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
    expect(
      (JSON.parse((await backing.get(SUMMARY_INDEX_KEY))!) as { formatVersion: number })
        .formatVersion,
    ).toBe(3);
  });
});

describe('session.fork() through a message', () => {
  const TURNS: ReadonlyArray<readonly ['user' | 'assistant', string]> = [
    ['user', 'first question'],
    ['assistant', 'first answer'],
    ['user', 'second question'],
    ['assistant', 'second answer'],
  ];

  async function source() {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const conversation = new Conversation(createConversationHistory());
    for (const [role, content] of TURNS) conversation.appendMessages({ role, content });
    const history = conversation.current;
    await store.save(
      createAgentSession({
        id: 'source',
        agentName: 'fork-agent',
        conversationHistory: history,
        metadata: { [SESSION_OWNER_METADATA_KEY]: 'alice' },
        runs: [],
      }),
    );
    const handle = createSessionHandle('source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });
    return { store, handle, ids: history.ids };
  }

  it('copies the history through that message and records the parent and the message', async () => {
    const { store, handle, ids } = await source();

    const forked = await handle.fork({ throughMessageId: ids[1]! });

    const session = await store.load(forked.id);
    expect(session?.conversationHistory.ids).toEqual([ids[0]!, ids[1]!]);
    expect(Object.keys(session?.conversationHistory.messages ?? {})).toEqual([ids[0]!, ids[1]!]);
    expect(session?.metadata).toEqual({
      [SESSION_OWNER_METADATA_KEY]: 'alice',
      [SESSION_PARENT_METADATA_KEY]: 'source',
      [SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]: ids[1]!,
    });
    const parent = await store.load('source');
    expect(parent?.conversationHistory.ids).toEqual(ids);
    const rows = await store.list({ owner: 'alice' });
    expect(rows.find((row) => row.id === forked.id)).toMatchObject({
      parentContextId: 'source',
      forkedFromMessageId: ids[1]!,
      messageCount: 2,
    });
  });

  it('gives the fork the owner it is told, not the source’s', async () => {
    const { store, handle, ids } = await source();

    const forked = await handle.fork({ throughMessageId: ids[3]!, owner: 'bob' });

    const stored = await store.load(forked.id);
    expect(stored?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('bob');
    const owned = await store.list({ owner: 'bob' });
    expect(owned.map((row) => row.id)).toEqual([forked.id]);
  });

  it('creates the fork under the identifier it is given', async () => {
    const { store, handle, ids } = await source();

    const forked = await handle.fork({ throughMessageId: ids[1]!, id: 'planned-id' });

    expect(forked.id).toBe('planned-id');
    expect(await store.exists('planned-id')).toBe(true);
  });

  it('creates nothing more when the same fork is asked for again under the same identifier', async () => {
    const { store, handle, ids } = await source();
    const options = { throughMessageId: ids[1]!, id: 'planned-id', owner: 'alice' };
    await handle.fork(options);
    const listedBefore = await store.list({});
    const before = listedBefore.length;

    const again = await handle.fork(options);

    expect(again.id).toBe('planned-id');
    const listedAfter = await store.list({});
    expect(listedAfter.length).toBe(before);
  });

  it('refuses an identifier a different session already holds, and changes nothing', async () => {
    const { store, handle, ids } = await source();
    await store.save(sessionWith('taken', { [SESSION_OWNER_METADATA_KEY]: 'alice' }));
    await handle.fork({ throughMessageId: ids[1]!, id: 'planned-id' });

    expect(
      await rejectionOf(handle.fork({ throughMessageId: ids[1]!, id: 'taken' })),
    ).toBeInstanceOf(ForkIdentifierInUseError);
    expect(
      await rejectionOf(handle.fork({ throughMessageId: ids[3]!, id: 'planned-id' })),
    ).toBeInstanceOf(ForkIdentifierInUseError);
    const kept = await store.load('planned-id');
    expect(kept?.metadata[SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]).toBe(ids[1]);
  });

  it('refuses the same fork asked for again under the same identifier for another owner', async () => {
    const { store, handle, ids } = await source();
    await handle.fork({ throughMessageId: ids[1]!, id: 'planned-id', owner: 'alice' });

    expect(
      await rejectionOf(handle.fork({ throughMessageId: ids[1]!, id: 'planned-id', owner: 'bob' })),
    ).toBeInstanceOf(ForkIdentifierInUseError);

    const kept = await store.load('planned-id');
    expect(kept?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('alice');
  });

  it('does not recreate a session deleted before the fork, and refuses the message', async () => {
    const { store, handle, ids } = await source();
    await store.delete('source');

    expect(await rejectionOf(handle.fork({ throughMessageId: ids[1]! }))).toBeInstanceOf(
      ForkThroughMessageError,
    );

    expect(await store.exists('source')).toBe(false);
  });

  it('refuses a message the session does not hold, and creates nothing', async () => {
    const { store, handle } = await source();
    const listedBefore = await store.list({});
    const before = listedBefore.length;

    expect(await rejectionOf(handle.fork({ throughMessageId: 'no-such-message' }))).toBeInstanceOf(
      ForkThroughMessageError,
    );

    const listedAfter = await store.list({});
    expect(listedAfter.length).toBe(before);
  });

  it('refuses a fork that names both a run and a message', async () => {
    const { handle, ids } = await source();

    expect(
      await rejectionOf(handle.fork({ throughRun: 0, throughMessageId: ids[1]! })),
    ).toBeInstanceOf(TypeError);
  });

  it('records no lineage for a fork that names no message, as before', async () => {
    const { store, handle } = await source();

    const forked = await handle.fork();

    const stored = await store.load(forked.id);
    expect(stored?.metadata).toEqual({ [SESSION_OWNER_METADATA_KEY]: 'alice' });
  });
});
