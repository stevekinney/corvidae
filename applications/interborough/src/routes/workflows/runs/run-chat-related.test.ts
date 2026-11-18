/** The other runs of the same chat, as the Details rail lists them. */
import { describe, expect, test } from 'bun:test';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { CHAT_RELATED_LIMIT, otherRunsOfChat } from './run-chat-related.ts';

describe('otherRunsOfChat', () => {
  test('leaves out the run itself and lists the rest, the most recently started first', () => {
    const tasks = [
      taskFixture({ id: 'run-1', createdAt: '2026-11-02T10:30:00.000Z' }),
      taskFixture({ id: 'run-2', createdAt: '2026-11-02T10:42:00.000Z' }),
      taskFixture({ id: 'run-3', createdAt: '2026-11-02T09:46:00.000Z' }),
    ];

    expect(otherRunsOfChat('run-1', tasks).map((task) => task.id)).toEqual(['run-2', 'run-3']);
  });

  test('has nothing to list for a chat with one run', () => {
    expect(otherRunsOfChat('run-1', [taskFixture({ id: 'run-1' })])).toEqual([]);
  });

  test('lists a few and no more', () => {
    const tasks = Array.from({ length: CHAT_RELATED_LIMIT + 3 }, (_, index) =>
      taskFixture({
        id: `run-${String(index)}`,
        createdAt: `2026-11-02T10:${String(10 + index)}:00.000Z`,
      }),
    );

    expect(otherRunsOfChat('none', tasks)).toHaveLength(CHAT_RELATED_LIMIT);
  });

  test('is never the run’s own continuation or the run it continues, which Runs lists as one row (COR-2423)', () => {
    const tasks = [
      taskFixture({ id: 'run-asked', createdAt: '2026-11-02T16:30:00.000Z' }),
      taskFixture({
        id: 'run-continued',
        continues: 'run-asked',
        createdAt: '2026-11-02T16:33:00.000Z',
      }),
      taskFixture({ id: 'run-later', createdAt: '2026-11-02T16:40:00.000Z' }),
    ];

    expect(otherRunsOfChat('run-asked', tasks).map((task) => task.id)).toEqual(['run-later']);
    expect(otherRunsOfChat('run-continued', tasks).map((task) => task.id)).toEqual(['run-later']);
  });
});
