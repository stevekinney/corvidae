import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import type { BureauHandlerSource } from '../create-bureau-handler.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';
import {
  answering,
  authentication,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
} from './management-fixtures.test-support.ts';

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
  const run = await opened.bureau.createRun({
    agentName: 'default',
    message: options.message,
    principal: options.principal,
    ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
  });
  await waitForCondition(() => opened.bureau.getRun(run.id)?.status === 'completed', 'finish');
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
        second.sessionId,
        first.sessionId,
      ]);
      expect(contextsOf(body)[0]).toMatchObject({
        id: second.sessionId,
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
        one.sessionId,
        two.sessionId,
        three.sessionId,
      ]);
      expect(contextsOf(writers).map((context) => context.id)).toEqual([
        three.sessionId,
        one.sessionId,
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
        created.push(session.sessionId);
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
      await opened.bureau.sessionStore!.updateMetadata(run.sessionId, {
        lastRequestAuthorities: { 'api-key:alice': 'AUTHORITY-SENTINEL' },
        skillSnapshots: { revision: 'SKILL-SNAPSHOT-SENTINEL' },
      });

      const list = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const get = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.sessionId },
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
      const stored = await opened.bureau.sessionStore!.load(run.sessionId);
      // A person's chat writes no origin: the default is what the record reads as, not a stored value.
      expect(stored?.metadata['sessionOrigin']).toBeUndefined();

      const list = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const get = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.sessionId },
        'alice-key',
      );

      expect(contextsOf(list).map((context) => context.origin)).toEqual(['chat']);
      expect(get.result).toMatchObject({ id: run.sessionId, origin: 'chat' });
    });
  });

  it('shows the origin a goal or a schedule’s fire recorded, and a chat for a value that is none of them', async () => {
    await withBureau(catalog, async (opened) => {
      const goal = await finishedSession(opened, { principal: OWNER.alice, message: 'goal' });
      const fire = await finishedSession(opened, { principal: OWNER.alice, message: 'fire' });
      const garbled = await finishedSession(opened, { principal: OWNER.alice, message: 'odd' });
      const store = opened.bureau.sessionStore!;
      await store.updateMetadata(goal.sessionId, { sessionOrigin: 'goal' });
      await store.updateMetadata(fire.sessionId, { sessionOrigin: 'schedule' });
      await store.updateMetadata(garbled.sessionId, { sessionOrigin: 'cron' });

      const list = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');

      const originOf = new Map(contextsOf(list).map((context) => [context.id, context.origin]));
      expect(originOf.get(goal.sessionId)).toBe('goal');
      expect(originOf.get(fire.sessionId)).toBe('schedule');
      expect(originOf.get(garbled.sessionId)).toBe('chat');
    });
  });

  it('filters by origin before it pages, so a page of chats holds chats however many fires are newer', async () => {
    await withBureau(catalog, async (opened) => {
      const chat = await finishedSession(opened, { principal: OWNER.alice, message: 'the chat' });
      const goal = await finishedSession(opened, { principal: OWNER.alice, message: 'goal' });
      const fire = await finishedSession(opened, { principal: OWNER.alice, message: 'fire' });
      const store = opened.bureau.sessionStore!;
      await store.updateMetadata(goal.sessionId, { sessionOrigin: 'goal' });
      await store.updateMetadata(fire.sessionId, { sessionOrigin: 'schedule' });

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

      expect(contextsOf(chats).map((context) => context.id)).toEqual([chat.sessionId]);
      expect(chats.result?.['nextOffset']).toBeNull();
      expect(contextsOf(goals).map((context) => context.id)).toEqual([goal.sessionId]);
      expect(contextsOf(fires).map((context) => context.id)).toEqual([fire.sessionId]);
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
      const running = await opened.bureau.createRun({
        agentName: 'default',
        message: 'hold',
        principal: OWNER.alice,
      });
      const waiting = await opened.bureau.createRun({
        agentName: 'default',
        message: 'park',
        principal: OWNER.alice,
      });
      await waitForCondition(
        () => opened.bureau.getRun(running.id)?.status === 'running',
        'running',
      );
      await waitForCondition(
        () => opened.bureau.listPendingReviews().some((review) => review.runId === waiting.id),
        'the run never parked',
      );

      const body = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');

      const activity = Object.fromEntries(
        contextsOf(body).map((context) => [context.id, context.activity]),
      );
      expect(activity).toEqual({
        [idle.sessionId]: 'idle',
        [running.sessionId]: 'running',
        [waiting.sessionId]: 'awaiting-input',
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
        tasks: {
          value: {
            ...opened.bureau.tasks,
            activityOf: (contextIds: readonly string[]) => {
              queries += 1;
              return opened.bureau.tasks.activityOf(contextIds);
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
      const session = await opened.bureau.getSession(run.sessionId);
      const transcript = Object.values(session!.conversationHistory.messages).map((message) =>
        typeof message.content === 'string' ? message.content : '',
      );

      const body = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.sessionId },
        'alice-key',
      );

      expect(body.result).toMatchObject({
        id: run.sessionId,
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
        { contextId: run.sessionId },
        'bob-key',
      );
      const writeOnly = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.sessionId },
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
        { contextId: run.sessionId },
        'operator-key',
      );

      expect(stranger.error?.data?.httpStatus).toBe(404);
      expect(writeOnly.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(stranger).replaceAll(run.sessionId, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
      );
      expect(operator.result).toMatchObject({ id: run.sessionId, owner: OWNER.alice });
    });
  });
});
