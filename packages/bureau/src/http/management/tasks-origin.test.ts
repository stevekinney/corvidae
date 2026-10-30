/**
 * A task says where it came from (COR-1867): `bureau.tasks.list` filters by the kind, and every
 * view carries the origin with its identifiers, or `null` for a task recorded before origins.
 */
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { TASK_RECORD_KEY_PREFIX } from '../../task-registry.ts';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  rpc,
} from './management-fixtures.test-support.ts';

async function withBureau<T>(body: (opened: OpenedBureau) => Promise<T>): Promise<T> {
  const opened = await openBureau({
    agents: { holder: createAgent({ generate: parkingUntilAborted }) },
  });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

type OriginTask = { id: string; origin: { kind: string } | null };

const tasksOf = (body: Awaited<ReturnType<typeof rpc>>) =>
  (body.result?.['tasks'] ?? []) as OriginTask[];

describe('a task view’s origin', () => {
  it('reads back what each start declared, with its identifiers', async () => {
    await withBureau(async (opened) => {
      const undeclared = await opened.bureau.tasks.start('holder', 'a', {
        principal: OWNER.alice,
      });
      const chat = await opened.bureau.tasks.start('holder', 'b', {
        principal: OWNER.alice,
        contextId: 'chat-context',
        origin: { kind: 'chat' },
      });
      const person = await opened.bureau.tasks.start('holder', 'c', {
        principal: OWNER.alice,
        origin: { kind: 'person', surface: 'web' },
      });
      try {
        const read = async (taskId: string) => {
          const body = await rpc(opened.handler, 'bureau.tasks.get', { taskId }, 'alice-key');
          return body.result?.['origin'];
        };

        expect(await read(undeclared.id)).toEqual({ kind: 'api' });
        expect(await read(chat.id)).toEqual({
          kind: 'chat',
          contextId: 'chat-context',
          agentName: 'holder',
          principal: OWNER.alice,
        });
        expect(await read(person.id)).toEqual({
          kind: 'person',
          principal: OWNER.alice,
          surface: 'web',
        });
      } finally {
        for (const task of [undeclared, chat, person]) task.abort('test over');
      }
    });
  });

  it('reads null for a record stored without one', async () => {
    await withBureau(async (opened) => {
      await opened.bureau.internals.kv!.set(
        `${TASK_RECORD_KEY_PREFIX}run-old`,
        JSON.stringify({
          schemaVersion: 1,
          taskId: 'run-old',
          contextId: 'context-old',
          incarnation: '',
          agentName: 'holder',
          owner: OWNER.alice,
          createdAt: '2026-09-01T00:00:00.000Z',
          history: [],
        }),
      );

      const read = await rpc(
        opened.handler,
        'bureau.tasks.get',
        { taskId: 'run-old' },
        'alice-key',
      );
      const listed = await rpc(opened.handler, 'bureau.tasks.list', {}, 'alice-key');

      expect(read.error).toBeUndefined();
      expect(read.result?.['origin']).toBeNull();
      expect(tasksOf(listed)).toMatchObject([{ id: 'run-old', origin: null }]);
    });
  });
});

describe('bureau.tasks.list with an origin', () => {
  it('returns only the tasks of that kind across pages, and refuses its token under another origin', async () => {
    await withBureau(async (opened) => {
      const started = [] as Awaited<ReturnType<typeof opened.bureau.tasks.start>>[];
      const start = async (origin: Parameters<typeof opened.bureau.tasks.start>[2] = {}) => {
        const task = await opened.bureau.tasks.start('holder', 'work', {
          principal: OWNER.alice,
          ...origin,
        });
        started.push(task);
        return task;
      };
      try {
        const chats = [
          await start({ origin: { kind: 'chat' } }),
          await start({ origin: { kind: 'chat' } }),
          await start({ origin: { kind: 'chat' } }),
        ];
        await start();
        await start({ origin: { kind: 'person', surface: 'palette' } });

        const pages: OriginTask[][] = [];
        let pageToken: string | undefined;
        let firstToken: string | undefined;
        do {
          const page = await rpc(
            opened.handler,
            'bureau.tasks.list',
            { origin: 'chat', limit: 2, ...(pageToken === undefined ? {} : { pageToken }) },
            'alice-key',
          );
          expect(page.error).toBeUndefined();
          pages.push(tasksOf(page));
          pageToken = (page.result?.['nextPageToken'] as string | null) ?? undefined;
          firstToken ??= pageToken;
        } while (pageToken !== undefined);

        expect(pages.map((page) => page.length)).toEqual([2, 1]);
        expect(
          pages
            .flat()
            .map((task) => task.id)
            .toSorted(),
        ).toEqual(chats.map((task) => task.id).toSorted());
        expect(pages.flat().every((task) => task.origin?.kind === 'chat')).toBe(true);

        const crossed = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { origin: 'person', limit: 2, pageToken: firstToken },
          'alice-key',
        );
        const dropped = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { limit: 2, pageToken: firstToken },
          'alice-key',
        );
        for (const refused of [crossed, dropped]) {
          expect(refused.error?.data?.httpStatus).toBe(400);
          expect(JSON.stringify(refused.error)).toContain('page-token-filters');
        }
        // No task of a schedule exists here; the filter answers an empty page, not an error.
        const none = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { origin: 'schedule' },
          'alice-key',
        );
        expect(tasksOf(none)).toEqual([]);
      } finally {
        for (const task of started) task.abort('test over');
      }
    });
  });

  it('answers InvalidParams to a kind that is not one', async () => {
    await withBureau(async (opened) => {
      const body = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { origin: 'teleport' },
        'alice-key',
      );

      expect(body.error?.data?.httpStatus).toBe(400);
    });
  });
});

describe('bureau.tasks.list of subordinate tasks (COR-1868)', () => {
  /** Seeds records directly: nothing admits a child, an attempt or a step yet. */
  async function seedFamily(opened: OpenedBureau) {
    const seeds: [string, string, Record<string, unknown>][] = [
      ['child-1', OWNER.alice, { kind: 'agent', parentRunId: 'run-p', agentName: 'holder' }],
      ['child-2', OWNER.alice, { kind: 'agent', parentRunId: 'run-p', agentName: 'holder' }],
      ['child-3', OWNER.alice, { kind: 'agent', parentRunId: 'run-p', agentName: 'holder' }],
      ['bobs-child', OWNER.bob, { kind: 'agent', parentRunId: 'run-p', agentName: 'holder' }],
      ['attempt-1', OWNER.alice, { kind: 'goal', goalRunId: 'goal-g', attemptId: 'attempt-1' }],
      ['step-1', OWNER.alice, { kind: 'parent', parentRunId: 'workflow-w' }],
    ];
    for (const [taskId, owner, origin] of seeds) {
      await opened.bureau.internals.kv!.set(
        `${TASK_RECORD_KEY_PREFIX}${taskId}`,
        JSON.stringify({
          schemaVersion: 1,
          taskId,
          contextId: `context-${taskId}`,
          incarnation: '',
          agentName: 'holder',
          owner,
          origin,
          createdAt: `2026-09-01T00:00:0${seeds.findIndex(([id]) => id === taskId)}.000Z`,
          history: [],
        }),
      );
    }
  }

  async function pagesOf(opened: OpenedBureau, params: Record<string, unknown>, key = 'alice-key') {
    const pages: OriginTask[][] = [];
    const tokens: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { ...params, ...(pageToken === undefined ? {} : { pageToken }) },
        key,
      );
      expect(page.error).toBeUndefined();
      pages.push(tasksOf(page));
      pageToken = (page.result?.['nextPageToken'] as string | null) ?? undefined;
      if (pageToken !== undefined) tokens.push(pageToken);
    } while (pageToken !== undefined);
    return { pages, tokens };
  }

  it('reads the new origins, and filters by their kind', async () => {
    await withBureau(async (opened) => {
      await seedFamily(opened);

      const read = await rpc(
        opened.handler,
        'bureau.tasks.get',
        { taskId: 'attempt-1' },
        'alice-key',
      );
      const goals = await pagesOf(opened, { origin: 'goal' });
      const parents = await pagesOf(opened, { origin: 'parent' });

      expect(read.result?.['origin']).toEqual({
        kind: 'goal',
        goalRunId: 'goal-g',
        attemptId: 'attempt-1',
      });
      expect(goals.pages.flat().map((task) => task.id)).toEqual(['attempt-1']);
      expect(parents.pages.flat().map((task) => task.id)).toEqual(['step-1']);
    });
  });

  it('filters by parentRunId across pages and refuses the token under another filter', async () => {
    await withBureau(async (opened) => {
      await seedFamily(opened);

      const { pages, tokens } = await pagesOf(opened, { parentRunId: 'run-p', limit: 2 });
      const crossed = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { parentRunId: 'workflow-w', limit: 2, pageToken: tokens[0] },
        'alice-key',
      );
      const dropped = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { limit: 2, pageToken: tokens[0] },
        'alice-key',
      );

      expect(pages.map((page) => page.length)).toEqual([2, 1]);
      expect(
        pages
          .flat()
          .map((task) => task.id)
          .toSorted(),
      ).toEqual(['child-1', 'child-2', 'child-3']);
      for (const refused of [crossed, dropped]) {
        expect(refused.error?.data?.httpStatus).toBe(400);
        expect(JSON.stringify(refused.error)).toContain('page-token-filters');
      }
    });
  });

  it('filters by siblingsOf across pages, within the caller’s reach', async () => {
    await withBureau(async (opened) => {
      await seedFamily(opened);

      const own = await pagesOf(opened, { siblingsOf: 'child-2', limit: 1 });
      const ofBobs = await pagesOf(opened, { siblingsOf: 'bobs-child', limit: 1 });
      const ofAlicesAsBob = await pagesOf(opened, { siblingsOf: 'child-1' }, 'bob-key');
      const parentless = await pagesOf(opened, { siblingsOf: 'holder-top-level' });
      const crossed = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { siblingsOf: 'child-3', limit: 1, pageToken: own.tokens[0] },
        'alice-key',
      );

      expect(
        own.pages
          .flat()
          .map((task) => task.id)
          .toSorted(),
      ).toEqual(['child-1', 'child-3']);
      // A task outside the caller's reach answers as if it did not exist, in both directions.
      expect(ofBobs.pages.flat()).toEqual([]);
      expect(ofAlicesAsBob.pages.flat()).toEqual([]);
      expect(parentless.pages.flat()).toEqual([]);
      expect(JSON.stringify(crossed.error)).toContain('page-token-filters');
    });
  });

  it('answers InvalidParams to an empty parentRunId or siblingsOf', async () => {
    await withBureau(async (opened) => {
      for (const params of [{ parentRunId: '' }, { siblingsOf: '' }]) {
        const body = await rpc(opened.handler, 'bureau.tasks.list', params, 'alice-key');
        expect(body.error?.data?.httpStatus).toBe(400);
      }
    });
  });
});
