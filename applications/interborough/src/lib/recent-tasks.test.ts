import { describe, expect, test } from 'bun:test';

import type { TaskView } from './bureau-tasks.ts';
import { chatsWithFailedRun, latestRunByChat } from './recent-tasks.ts';

const task = (id: string, contextId: string, status: TaskView['status'], updatedAt: string) =>
  ({
    id,
    contextId,
    agentName: 'assistant',
    owner: 'anonymous:local',
    actor: null,
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
