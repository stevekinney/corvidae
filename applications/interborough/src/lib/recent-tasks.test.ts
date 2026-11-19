import { afterEach, describe, expect, test } from 'bun:test';

import type { TaskView } from './bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from './bureau-world.test-support.ts';
import {
  chatsWithFailedRun,
  latestRunByChat,
  RECENT_TASK_LIMIT,
  recentTasksQuery,
} from './recent-tasks.ts';

const task = (id: string, contextId: string, status: TaskView['status'], updatedAt: string) =>
  ({
    id,
    contextId,
    agentName: 'assistant',
    owner: 'anonymous:local',
    actor: null,
    kind: 'chat',
    status,
    finishReason: null,
    statusMessage: null,
    createdAt: updatedAt,
    updatedAt,
    cleanup: null,
    openWaits: [],
  }) satisfies TaskView;

describe('the latest run of each chat', () => {
  test('is the task changed last, whatever order the Bureau listed them in', () => {
    const latest = latestRunByChat([
      task('old', 'chat-1', 'failed', '2026-10-23T08:00:00.000Z'),
      task('new', 'chat-1', 'completed', '2026-10-23T09:00:00.000Z'),
      task('only', 'chat-2', 'failed', '2026-10-23T07:00:00.000Z'),
    ]);

    expect(latest.get('chat-1')?.id).toBe('new');
    expect(latest.get('chat-2')?.id).toBe('only');
  });

  test('names a chat as failed only when its latest run is the failed one', () => {
    expect(
      chatsWithFailedRun([
        task('a', 'recovered', 'failed', '2026-10-23T08:00:00.000Z'),
        task('b', 'recovered', 'completed', '2026-10-23T09:00:00.000Z'),
        task('c', 'broken', 'completed', '2026-10-23T08:00:00.000Z'),
        task('d', 'broken', 'failed', '2026-10-23T09:00:00.000Z'),
        task('e', 'canceled', 'canceled', '2026-10-23T09:00:00.000Z'),
      ]),
    ).toEqual(new Set(['broken']));
  });
});

describe('the read of the most recent tasks', () => {
  let stub: BureauWorldStub | undefined;
  afterEach(() => {
    stub?.restore();
    stub = undefined;
  });

  test('asks for the tasks that have records only, so the engine’s runs take none of its slots (COR-2424)', async () => {
    // A page as the Bureau lists it: the engine's runs newest, filling the whole page, and behind
    // them the chat's failed run, which the chat list marks.
    const engineRuns = Array.from({ length: RECENT_TASK_LIMIT }, (_, index) => ({
      ...task(
        `schedule-tick:${String(index)}`,
        `schedule-tick:${String(index)}`,
        'completed',
        '2026-11-02T10:00:00.000Z',
      ),
      agentName: null,
    }));
    const chatRun = task('chat-run', 'chat-1', 'failed', '2026-11-01T09:00:00.000Z');
    stub = installBureauWorld(emptyBureauWorld({ tasks: [] }));
    stub.on('bureau.tasks.list', (params) => {
      const listed = params['engineRuns'] === false ? [chatRun] : [...engineRuns, chatRun];
      return {
        tasks: listed.slice(0, typeof params['limit'] === 'number' ? params['limit'] : 50),
        nextPageToken: null,
      };
    });

    const page = await recentTasksQuery().queryFn({ signal: new AbortController().signal });

    expect(page.tasks.map((listed) => listed.id)).toEqual(['chat-run']);
    expect(chatsWithFailedRun(page.tasks)).toEqual(new Set(['chat-1']));
  });
});
