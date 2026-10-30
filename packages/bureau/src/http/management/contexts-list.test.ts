import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createAgentSession,
  createSessionStore,
  type GenerateFunction,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { Conversation, createConversationHistory } from 'conversationalist';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import type { BureauHandlerSource } from '../create-bureau-handler.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';
import { contextsListOperation } from './contexts-operations.ts';
import {
  answering,
  authentication,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
} from './management-fixtures.test-support.ts';
import { startTaskFrom } from '../../test/task-start-request.ts';

async function withBureau<T>(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau(options);
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

type Context = {
  id: string;
  owner: string | null;
  agentName: string;
  title: string | null;
  lastMessagePreview: string | null;
  origin: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  activity: string;
};

const contextsOf = (body: Awaited<ReturnType<typeof rpc>>) =>
  (body.result?.['contexts'] ?? []) as Context[];

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A finished one-turn session. */
async function finishedSession(
  opened: OpenedBureau,
  options: { principal: string; message: string; agentName?: string },
) {
  const run = await startTaskFrom(opened.bureau, {
    agentName: 'default',
    input: options.message,
    principal: options.principal,
    ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
  });
  await waitForCondition(
    () => opened.bureau.tasks.detail(run.id)?.status === 'completed',
    'finish',
  );
  await pause();
  return run;
}

const writer = createAgent({ name: 'writer', generate: answering() });
const editor = createAgent({ name: 'editor', generate: answering() });
const catalog = { agents: { writer, editor }, generate: answering() };

describe('bureau.contexts.list', () => {
  it('returns the caller’s own sessions newest update first, with title, preview, count, owner and times', async () => {
    await withBureau(catalog, async (opened) => {
      const first = await finishedSession(opened, {
        principal: OWNER.alice,
        message: 'first chat',
      });
      const second = await finishedSession(opened, {
        principal: OWNER.alice,
        message: 'second chat',
      });
      await finishedSession(opened, { principal: OWNER.bob, message: 'bob’s chat' });

      const body = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');

      expect(contextsOf(body).map((context) => context.id)).toEqual([
        second.contextId,
        first.contextId,
      ]);
      expect(contextsOf(body)[0]).toMatchObject({
        id: second.contextId,
        owner: OWNER.alice,
        agentName: 'default',
        title: 'second chat',
        lastMessagePreview: 'Done.',
        activity: 'idle',
      });
      expect(contextsOf(body)[0]?.messageCount).toBeGreaterThanOrEqual(2);
      expect(typeof contextsOf(body)[0]?.createdAt).toBe('string');
      expect(typeof contextsOf(body)[0]?.updatedAt).toBe('string');
      expect(body.result?.['nextOffset']).toBeNull();
    });
  });

  it('sorts oldest first when asked, and filters by agent', async () => {
    await withBureau(catalog, async (opened) => {
      const one = await finishedSession(opened, {
        principal: OWNER.alice,
        message: 'one',
        agentName: 'writer',
      });
      const two = await finishedSession(opened, {
        principal: OWNER.alice,
        message: 'two',
        agentName: 'editor',
      });
      const three = await finishedSession(opened, {
        principal: OWNER.alice,
        message: 'three',
        agentName: 'writer',
      });

      const oldest = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { sortOrder: 'asc', sortBy: 'createdAt' },
        'alice-key',
      );
      const writers = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { agentName: 'writer' },
        'alice-key',
      );

      expect(contextsOf(oldest).map((context) => context.id)).toEqual([
        one.contextId,
        two.contextId,
        three.contextId,
      ]);
      expect(contextsOf(writers).map((context) => context.id)).toEqual([
        three.contextId,
        one.contextId,
      ]);
    });
  });

  it('pages with limit and offset, returning nextOffset and null on the last page', async () => {
    await withBureau(catalog, async (opened) => {
      for (const message of ['a', 'b', 'c']) {
        await finishedSession(opened, { principal: OWNER.alice, message });
      }

      const first = await rpc(opened.handler, 'bureau.contexts.list', { limit: 2 }, 'alice-key');
      const last = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { limit: 2, offset: 2 },
        'alice-key',
      );

      expect(contextsOf(first)).toHaveLength(2);
      expect(first.result?.['nextOffset']).toBe(2);
      expect(contextsOf(last)).toHaveLength(1);
      expect(last.result?.['nextOffset']).toBeNull();
    });
  });

  it('applies the owner filter in the index before the page, so with two owners and a page size of 1 every page is full', async () => {
    await withBureau(catalog, async (opened) => {
      // Alice, bob, alice, bob, alice: newest first they alternate, so a filter applied
      // after the page would return empty pages.
      const created: string[] = [];
      for (const [principal, message] of [
        [OWNER.alice, 'a1'],
        [OWNER.bob, 'b1'],
        [OWNER.alice, 'a2'],
        [OWNER.bob, 'b2'],
        [OWNER.alice, 'a3'],
      ] as const) {
        const session = await finishedSession(opened, { principal, message });
        created.push(session.contextId);
      }
      const alices = [created[4], created[2], created[0]];

      const seen: string[] = [];
      const offsets: Array<number | null> = [];
      for (let offset = 0; offset < 3; offset += 1) {
        const page = await rpc(
          opened.handler,
          'bureau.contexts.list',
          { limit: 1, offset },
          'alice-key',
        );
        expect(contextsOf(page)).toHaveLength(1);
        seen.push(contextsOf(page)[0]!.id);
        offsets.push(page.result?.['nextOffset'] as number | null);
      }

      expect(seen).toEqual(alices as string[]);
      expect(offsets).toEqual([1, 2, null]);
    });
  });

  it('lists every owner’s with allOwners and bureau.contexts:read, and refuses allOwners without it', async () => {
    await withBureau(catalog, async (opened) => {
      await finishedSession(opened, { principal: OWNER.alice, message: 'a' });
      await finishedSession(opened, { principal: OWNER.bob, message: 'b' });

      const all = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { allOwners: true },
        'operator-key',
      );
      const refused = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { allOwners: true },
        'alice-key',
      );
      const writeOnly = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { allOwners: true },
        'contexts-writer-key',
      );
      const operatorOwn = await rpc(opened.handler, 'bureau.contexts.list', {}, 'operator-key');

      expect(
        contextsOf(all)
          .map((context) => context.owner)
          .toSorted((left, right) => String(left).localeCompare(String(right))),
      ).toEqual([OWNER.alice, OWNER.bob]);
      expect(refused.error?.data?.httpStatus).toBe(403);
      // A write scope does not imply the read scope.
      expect(writeOnly.error?.data?.httpStatus).toBe(403);
      expect(contextsOf(operatorOwn)).toEqual([]);
    });
  });

  it('never returns Bureau-internal session metadata: request authorities and skill snapshots', async () => {
    await withBureau(catalog, async (opened) => {
      const run = await finishedSession(opened, { principal: OWNER.alice, message: 'secrets' });
      await opened.bureau.internals.sessionStore!.updateMetadata(run.contextId, {
        lastRequestAuthorities: { 'api-key:alice': 'AUTHORITY-SENTINEL' },
        skillSnapshots: { revision: 'SKILL-SNAPSHOT-SENTINEL' },
      });

      const list = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const get = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.contextId },
        'alice-key',
      );

      for (const body of [list, get]) {
        const text = JSON.stringify(body);
        expect(text).not.toContain('AUTHORITY-SENTINEL');
        expect(text).not.toContain('SKILL-SNAPSHOT-SENTINEL');
        expect(text).not.toContain('metadata');
        expect(text).not.toContain('lastRunId');
      }
    });
  });
});

describe('bureau.contexts origin', () => {
  it('reads a chat for a context that records no origin, as every context made before origins existed', async () => {
    await withBureau(catalog, async (opened) => {
      const run = await finishedSession(opened, { principal: OWNER.alice, message: 'a chat' });
      const stored = await opened.bureau.internals.sessionStore!.load(run.contextId);
      // A person's chat writes no origin: the default is what the record reads as, not a stored value.
      expect(stored?.metadata['sessionOrigin']).toBeUndefined();

      const list = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const get = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.contextId },
        'alice-key',
      );

      expect(contextsOf(list).map((context) => context.origin)).toEqual(['chat']);
      expect(get.result).toMatchObject({ id: run.contextId, origin: 'chat' });
    });
  });

  it('shows the origin a goal or a schedule’s fire recorded, and a chat for a value that is none of them', async () => {
    await withBureau(catalog, async (opened) => {
      const goal = await finishedSession(opened, { principal: OWNER.alice, message: 'goal' });
      const fire = await finishedSession(opened, { principal: OWNER.alice, message: 'fire' });
      const garbled = await finishedSession(opened, { principal: OWNER.alice, message: 'odd' });
      const store = opened.bureau.internals.sessionStore!;
      await store.updateMetadata(goal.contextId, { sessionOrigin: 'goal' });
      await store.updateMetadata(fire.contextId, { sessionOrigin: 'schedule' });
      await store.updateMetadata(garbled.contextId, { sessionOrigin: 'cron' });

      const list = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');

      const originOf = new Map(contextsOf(list).map((context) => [context.id, context.origin]));
      expect(originOf.get(goal.contextId)).toBe('goal');
      expect(originOf.get(fire.contextId)).toBe('schedule');
      expect(originOf.get(garbled.contextId)).toBe('chat');
    });
  });

  it('filters by origin before it pages, so a page of chats holds chats however many fires are newer', async () => {
    await withBureau(catalog, async (opened) => {
      const chat = await finishedSession(opened, { principal: OWNER.alice, message: 'the chat' });
      const goal = await finishedSession(opened, { principal: OWNER.alice, message: 'goal' });
      const fire = await finishedSession(opened, { principal: OWNER.alice, message: 'fire' });
      const store = opened.bureau.internals.sessionStore!;
      await store.updateMetadata(goal.contextId, { sessionOrigin: 'goal' });
      await store.updateMetadata(fire.contextId, { sessionOrigin: 'schedule' });

      const chats = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { origin: 'chat', limit: 1 },
        'alice-key',
      );
      const goals = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { origin: 'goal' },
        'alice-key',
      );
      const fires = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { origin: 'schedule' },
        'alice-key',
      );

      expect(contextsOf(chats).map((context) => context.id)).toEqual([chat.contextId]);
      expect(chats.result?.['nextOffset']).toBeNull();
      expect(contextsOf(goals).map((context) => context.id)).toEqual([goal.contextId]);
      expect(contextsOf(fires).map((context) => context.id)).toEqual([fire.contextId]);
    });
  });

  it('refuses an origin it does not know as invalid parameters', async () => {
    await withBureau(catalog, async (opened) => {
      const body = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { origin: 'cron' },
        'alice-key',
      );

      expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
    });
  });
});

describe('bureau.contexts.list activity', () => {
  /** Runs that hold, park on a human wait, or finish, by their message. */
  const byMessage: GenerateFunction = ({ conversation, signal }) => {
    const { ids, messages } = conversation.current;
    const first = ids.map((id) => messages[id]).find((message) => message?.role === 'user');
    const text = typeof first?.content === 'string' ? first.content : '';
    if (text === 'park') {
      return Promise.resolve({
        content: '',
        toolCalls: [
          {
            id: 'wait-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'human-response', prompt: 'Which?' },
          },
        ],
      });
    }
    if (text === 'hold') {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return Promise.resolve({ content: 'finished', toolCalls: [] });
  };

  it('is running for a working session, awaiting-input for one waiting on a human, and idle otherwise', async () => {
    await withBureau({ generate: byMessage }, async (opened) => {
      const idle = await finishedSession(opened, { principal: OWNER.alice, message: 'idle' });
      const running = await opened.bureau.tasks.start('default', 'hold', {
        principal: OWNER.alice,
      });
      const waiting = await opened.bureau.tasks.start('default', 'park', {
        principal: OWNER.alice,
      });
      await waitForCondition(
        () => opened.bureau.tasks.detail(running.id)?.status === 'running',
        'running',
      );
      await waitForCondition(
        () => opened.bureau.reviews.list().some((review) => review.runId === waiting.id),
        'the run never parked',
      );

      const body = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');

      const activity = Object.fromEntries(
        contextsOf(body).map((context) => [context.id, context.activity]),
      );
      expect(activity).toEqual({
        [idle.contextId]: 'idle',
        [running.contextId]: 'running',
        [waiting.contextId]: 'awaiting-input',
      });
    });
  });

  it('computes activity with one task query for a whole page, not one per row', async () => {
    await withBureau(catalog, async (opened) => {
      for (const message of ['a', 'b', 'c', 'd']) {
        await finishedSession(opened, { principal: OWNER.alice, message });
      }
      let queries = 0;
      const counting = Object.create(opened.bureau, {
        internals: {
          value: {
            ...opened.bureau.internals,
            taskRegistry: {
              ...opened.bureau.internals.taskRegistry,
              activityOf: (contextIds: readonly string[]) => {
                queries += 1;
                return opened.bureau.internals.taskRegistry.activityOf(contextIds);
              },
            },
          },
        },
      }) as BureauHandlerSource;
      const handler = createBureauHandler(counting, { authentication });

      const body = await rpc(handler, 'bureau.contexts.list', {}, 'alice-key');

      expect(contextsOf(body)).toHaveLength(4);
      expect(queries).toBe(1);
    });
  });
});

describe('bureau.contexts.get', () => {
  it('returns one context’s summary and no message content beyond title and preview', async () => {
    await withBureau(catalog, async (opened) => {
      const run = await finishedSession(opened, {
        principal: OWNER.alice,
        message: 'the opening question',
      });
      const session = await opened.bureau.contexts.get(run.contextId);
      const transcript = Object.values(session!.conversationHistory.messages).map((message) =>
        typeof message.content === 'string' ? message.content : '',
      );

      const body = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.contextId },
        'alice-key',
      );

      expect(body.result).toMatchObject({
        id: run.contextId,
        owner: OWNER.alice,
        title: 'the opening question',
        lastMessagePreview: 'Done.',
        activity: 'idle',
      });
      expect(Object.keys(body.result ?? {}).toSorted()).toEqual([
        'activity',
        'agentName',
        'configVersion',
        'createdAt',
        'effort',
        'forkedFromMessageId',
        'id',
        'lastMessagePreview',
        'messageCount',
        'model',
        'origin',
        'owner',
        'parentContextId',
        'title',
        'updatedAt',
      ]);
      // The only message text is the title and the preview.
      const text = JSON.stringify(body);
      for (const row of transcript.filter(
        (content) => !['the opening question', 'Done.'].includes(content),
      )) {
        expect(row === '' || !text.includes(row)).toBe(true);
      }
    });
  });

  it('answers a context the caller may not see exactly as a missing one, and reads any owner’s for bureau.contexts:read', async () => {
    await withBureau(catalog, async (opened) => {
      const run = await finishedSession(opened, { principal: OWNER.alice, message: 'mine' });

      const stranger = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.contextId },
        'bob-key',
      );
      const writeOnly = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.contextId },
        'contexts-writer-key',
      );
      const missing = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: 'no-such-context' },
        'bob-key',
      );
      const operator = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.contextId },
        'operator-key',
      );

      expect(stranger.error?.data?.httpStatus).toBe(404);
      expect(writeOnly.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(stranger).replaceAll(run.contextId, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
      );
      expect(operator.result).toMatchObject({ id: run.contextId, owner: OWNER.alice });
    });
  });
});

describe('bureau.contexts.list by title', () => {
  const list = (opened: OpenedBureau, params: Record<string, unknown>) =>
    rpc(opened.handler, 'bureau.contexts.list', params, 'alice-key');

  it('returns only the contexts whose title contains the text, ignoring case, across pages', async () => {
    await withBureau(catalog, async (opened) => {
      const wanted = new Set<string>();
      for (const [index, message] of [
        'Plan the TRIP',
        'unrelated one',
        'another trip home',
        'unrelated two',
        'trip budget',
        'unrelated three',
      ].entries()) {
        const run = await finishedSession(opened, { principal: OWNER.alice, message });
        if (index % 2 === 0) wanted.add(run.contextId);
      }

      const first = await list(opened, { titleContains: 'trip', limit: 2 });
      const second = await list(opened, { titleContains: 'trip', limit: 2, offset: 2 });

      expect(contextsOf(first)).toHaveLength(2);
      expect(first.result?.['nextOffset']).toBe(2);
      expect(contextsOf(second)).toHaveLength(1);
      expect(second.result?.['nextOffset']).toBeNull();
      expect(new Set([...contextsOf(first), ...contextsOf(second)].map((c) => c.id))).toEqual(
        wanted,
      );
    });
  });

  it('matches a title given by rename, and not the first message it replaced', async () => {
    await withBureau(catalog, async (opened) => {
      const run = await finishedSession(opened, { principal: OWNER.alice, message: 'first words' });
      await opened.bureau.contexts.rename(run.contextId, 'Quarterly review');

      expect(contextsOf(await list(opened, { titleContains: 'quarterly' }))).toHaveLength(1);
      expect(contextsOf(await list(opened, { titleContains: 'first words' }))).toHaveLength(0);

      await opened.bureau.contexts.rename(run.contextId, null);

      expect(contextsOf(await list(opened, { titleContains: 'quarterly' }))).toHaveLength(0);
      expect(contextsOf(await list(opened, { titleContains: 'first words' }))).toHaveLength(1);
    });
  });

  it('never matches another owner’s contexts, and refuses an empty needle', async () => {
    await withBureau(catalog, async (opened) => {
      await finishedSession(opened, { principal: OWNER.bob, message: 'bob trip' });

      expect(contextsOf(await list(opened, { titleContains: 'trip' }))).toEqual([]);
      const empty = await list(opened, { titleContains: '' });
      expect(empty.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
    });
  });
});

describe('bureau.contexts.list by activity', () => {
  const byMessage: GenerateFunction = ({ conversation, signal }) => {
    const { ids, messages } = conversation.current;
    const first = ids.map((id) => messages[id]).find((message) => message?.role === 'user');
    const text = typeof first?.content === 'string' ? first.content : '';
    if (text.startsWith('hold')) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return Promise.resolve({ content: 'finished', toolCalls: [] });
  };

  it('returns only the contexts in that state, paged by matches, with the other filters applied', async () => {
    await withBureau({ generate: byMessage }, async (opened) => {
      const holding: string[] = [];
      for (const message of ['hold one', 'done one', 'hold two', 'done two', 'hold three']) {
        const run = await opened.bureau.tasks.start('default', message, {
          principal: OWNER.alice,
        });
        if (message.startsWith('hold')) {
          holding.push(run.contextId);
          await waitForCondition(
            () => opened.bureau.tasks.detail(run.id)?.status === 'running',
            'running',
          );
        } else {
          await waitForCondition(
            () => opened.bureau.tasks.detail(run.id)?.status === 'completed',
            'finish',
          );
        }
      }
      const call = (params: Record<string, unknown>) =>
        rpc(opened.handler, 'bureau.contexts.list', params, 'alice-key');

      const running = await call({ activity: 'running', limit: 2 });
      const rest = await call({ activity: 'running', limit: 2, offset: 2 });
      const idle = await call({ activity: 'idle' });
      const titled = await call({ activity: 'running', titleContains: 'TWO' });
      const waiting = await call({ activity: 'awaiting-input' });

      expect(contextsOf(running)).toHaveLength(2);
      expect(running.result?.['nextOffset']).toBe(2);
      expect(contextsOf(rest)).toHaveLength(1);
      expect(rest.result?.['nextOffset']).toBeNull();
      expect(
        new Set([...contextsOf(running), ...contextsOf(rest)].map((context) => context.id)),
      ).toEqual(new Set(holding));
      for (const context of [...contextsOf(running), ...contextsOf(rest)]) {
        expect(context.activity).toBe('running');
      }
      expect(contextsOf(idle).map((context) => context.title)).toEqual(['done two', 'done one']);
      expect(contextsOf(titled).map((context) => context.title)).toEqual(['hold two']);
      expect(contextsOf(waiting)).toEqual([]);
      expect(waiting.result?.['nextOffset']).toBeNull();
    });
  });

  it('refuses an activity it does not know as invalid parameters', async () => {
    await withBureau(catalog, async (opened) => {
      const body = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { activity: 'sleeping' },
        'alice-key',
      );

      expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
    });
  });
});

describe('bureau.contexts.list by activity across chunks', () => {
  /** A host over `count` synthetic contexts, of which every `period`th is running. */
  function syntheticHost(count: number, period: number) {
    const ids = Array.from(
      { length: count },
      (_, index) => `ctx-${String(index).padStart(4, '0')}`,
    );
    const summary = (id: string) => ({
      id,
      agentName: 'default',
      title: `title ${id}`,
      lastMessagePreview: null,
      owner: 'anonymous:local',
      parentContextId: null,
      forkedFromMessageId: null,
      messageCount: 1,
      createdAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z',
      metadata: {},
    });
    const reads: { offset: number | undefined; limit: number | undefined }[] = [];
    const queries: number[] = [];
    const host = {
      ownership: { mayAccess: () => true, runOwner: async () => undefined },
      contexts: {
        internals: { sessionStore: {} },
        list: async (options: { offset?: number; limit?: number }) => {
          const offset = options.offset ?? 0;
          const limit = options.limit ?? 100;
          reads.push({ offset: options.offset, limit: options.limit });
          return ids.slice(offset, offset + limit).map(summary);
        },
      },
      tasks: {
        activityOf: async (contextIds: readonly string[]) => {
          queries.push(contextIds.length);
          return new Map(
            contextIds.map((id) => [
              id,
              Number(id.slice(4)) % period === 0 ? ('running' as const) : ('idle' as const),
            ]),
          );
        },
      },
    };
    return { host, reads, queries, ids };
  }

  const principal = { method: 'unauthenticated-local', scopes: new Set<string>() };
  const callList = (host: unknown, input: Record<string, unknown>) =>
    contextsListOperation.invoke({ input, host, principal } as never) as Promise<{
      contexts: { id: string }[];
      nextOffset: number | null;
    }>;

  it('pages matches that sit far apart in the index, reading it once and classifying it in bounded chunks', async () => {
    const { host, reads, queries } = syntheticHost(450, 150);

    const first = await callList(host, { activity: 'running', limit: 2 });

    // ctx-0000, ctx-0150, ctx-0300 are running: two on the page, a third proves another follows.
    expect(first.contexts.map((context) => context.id)).toEqual(['ctx-0000', 'ctx-0150']);
    expect(first.nextOffset).toBe(2);
    // One read of the filtered index, with no offset to drift under a concurrent write, and the
    // task queries are bounded chunks of it.
    expect(reads).toHaveLength(1);
    expect(reads[0]?.offset).toBeUndefined();
    expect(queries.length).toBeGreaterThan(1);
    expect(Math.max(...queries)).toBeLessThanOrEqual(100);

    const second = await callList(host, { activity: 'running', limit: 2, offset: 2 });

    expect(second.contexts.map((context) => context.id)).toEqual(['ctx-0300']);
    expect(second.nextOffset).toBeNull();
  });

  it('ends at the last chunk, even a full one, with no further page', async () => {
    const { host, queries } = syntheticHost(200, 1000);

    const body = await callList(host, { activity: 'running' });

    // Only ctx-0000 matches; the scan classified both full chunks and found nothing more.
    expect(queries).toEqual([100, 100]);
    expect(body.contexts.map((context) => context.id)).toEqual(['ctx-0000']);
    expect(body.nextOffset).toBeNull();
  });

  it('stops classifying once the page is full and one more match is found', async () => {
    const { host, reads, queries } = syntheticHost(1000, 1);

    const body = await callList(host, { activity: 'running', limit: 3 });

    expect(body.contexts).toHaveLength(3);
    expect(body.nextOffset).toBe(3);
    expect(reads).toHaveLength(1);
    // The first chunk already held the page and the match that proves another follows.
    expect(queries).toEqual([100]);
  });
});

describe('bureau.contexts.list by activity while the index changes', () => {
  it('never shows a session twice in one page when one is reordered between chunk classifications', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-29T00:00:00.000Z' });
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    for (let index = 0; index < 250; index += 1) {
      const conversation = new Conversation(createConversationHistory());
      conversation.appendMessages({ role: 'user', content: `message ${index}` });
      runtime.setTime(Date.parse('2026-10-29T00:00:00.000Z') + index * 1000);
      await store.save(
        createAgentSession({
          id: `s${String(index).padStart(3, '0')}`,
          agentName: 'a',
          conversationHistory: conversation.current,
          metadata: {},
          runs: [],
        }),
      );
    }
    const indexed = await store.list({ limit: 1000 });
    const order = indexed.map((summary) => summary.id);
    const mover = order[200]!;
    let moved = false;
    const host = {
      ownership: { mayAccess: () => true, runOwner: async () => undefined },
      contexts: {
        internals: { sessionStore: store },
        list: (options: never) => store.list(options),
      },
      tasks: {
        activityOf: async (contextIds: readonly string[]) => {
          if (!moved) {
            moved = true;
            // A run on an older session commits between the scan's chunk classifications: it
            // moves to the top of the index.
            runtime.setTime(Date.parse('2027-01-01T00:00:00.000Z'));
            await store.update(mover, (session) => (session ? { ...session } : undefined));
          }
          return new Map(contextIds.map((id) => [id, 'running' as const]));
        },
      },
    };
    const principal = { method: 'unauthenticated-local', scopes: new Set<string>() };

    const body = (await contextsListOperation.invoke({
      input: { activity: 'running', offset: 50, limit: 100 },
      host,
      principal,
    } as never)) as { contexts: { id: string }[] };

    const ids = body.contexts.map((context) => context.id);
    // The page is cut from the index as it was read: the same hundred, none twice.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(order.slice(50, 150));
  });
});
