/**
 * A task says what its `contextId` names (COR-1689): a chat session, a schedule's fire in one, or a
 * catalog run's handle. A client that lists another owner's tasks cannot ask the session store,
 * because it lists only its own sessions, so the kind is how it tells a chat to link from a handle
 * no chat has.
 */
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import { taskViewKindOf } from '../../task-registry.ts';
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

describe('taskViewKindOf', () => {
  it('reads a fire from its record kind, a chat from a recorded incarnation, and anything else as catalog', () => {
    expect(taskViewKindOf({ kind: 'schedule-fire', incarnation: '' })).toBe('schedule-fire');
    expect(taskViewKindOf({ kind: 'schedule-fire', incarnation: 'incarnation-1' })).toBe(
      'schedule-fire',
    );
    expect(taskViewKindOf({ kind: undefined, incarnation: 'incarnation-1' })).toBe('chat');
    // A dispatch, and a `createRun` task of a Bureau with no session store, record no incarnation.
    expect(taskViewKindOf({ kind: undefined, incarnation: '' })).toBe('catalog');
  });
});

type KindedTask = { id: string; contextId: string; kind: string };

describe('a task view’s kind', () => {
  it('is chat for a session run, catalog for a bureau.run() dispatch, and schedule-fire for a fire', async () => {
    await withBureau(async (opened) => {
      const chat = await opened.bureau.createRun({
        agentName: 'holder',
        message: 'work',
        principal: OWNER.alice,
      });
      await waitForCondition(
        () => opened.bureau.getRun(chat.id)?.status === 'running',
        'the session run never started',
      );
      const catalog = opened.bureau.run('holder', 'work', { principal: OWNER.alice });
      await opened.bureau.tasks.recordAdmission({
        taskId: 'fire-1',
        contextId: 'fire-session',
        incarnation: '',
        agentName: 'holder',
        owner: OWNER.alice,
        actor: 'system:scheduler',
        kind: 'schedule-fire',
        message: undefined,
      });
      try {
        await waitForCondition(
          async () => (await opened.bureau.tasks.get(catalog.id)) !== undefined,
          'the dispatch was never recorded as a task',
        );

        const listed = await rpc(opened.handler, 'bureau.tasks.list', {}, 'alice-key');
        const kinds = new Map(
          ((listed.result?.['tasks'] ?? []) as KindedTask[]).map((task) => [task.id, task.kind]),
        );
        const fetched = await rpc(
          opened.handler,
          'bureau.tasks.get',
          { taskId: catalog.id },
          'alice-key',
        );

        expect(kinds.get(chat.id)).toBe('chat');
        expect(kinds.get(catalog.id)).toBe('catalog');
        expect(kinds.get('fire-1')).toBe('schedule-fire');
        expect(fetched.result).toMatchObject({ id: catalog.id, kind: 'catalog' });
      } finally {
        catalog.abort('test over');
        await catalog.closed();
      }
    });
  });
});
