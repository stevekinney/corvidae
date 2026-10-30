/**
 * A task says what its `contextId` names (COR-1689): a chat session, a schedule's fire in one, or a
 * handle no chat has (a task of a Bureau with no session store). A client that lists another owner's tasks cannot ask the session store,
 * because it lists only its own sessions, so the kind is how it tells a chat to link from a handle
 * no chat has.
 */
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition, closedTask } from '../../test';
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
  it('is chat for a task and schedule-fire for a fire', async () => {
    await withBureau(async (opened) => {
      const chat = await opened.bureau.tasks.start('holder', 'work', { principal: OWNER.alice });
      await waitForCondition(
        () => opened.bureau.tasks.detail(chat.id)?.status === 'running',
        'the session run never started',
      );
      await opened.bureau.internals.taskRegistry.recordAdmission({
        taskId: 'fire-1',
        contextId: 'fire-session',
        incarnation: '',
        agentName: 'holder',
        owner: OWNER.alice,
        actor: 'system:scheduler',
        kind: 'schedule-fire',
        origin: { kind: 'api' },
        message: undefined,
      });
      try {
        const listed = await rpc(opened.handler, 'bureau.tasks.list', {}, 'alice-key');
        const kinds = new Map(
          ((listed.result?.['tasks'] ?? []) as KindedTask[]).map((task) => [task.id, task.kind]),
        );
        const fetched = await rpc(
          opened.handler,
          'bureau.tasks.get',
          { taskId: chat.id },
          'alice-key',
        );

        expect(kinds.get(chat.id)).toBe('chat');
        expect(kinds.get('fire-1')).toBe('schedule-fire');
        expect(fetched.result).toMatchObject({ id: chat.id, kind: 'chat' });
      } finally {
        chat.abort('test over');
        await closedTask(opened.bureau, chat);
      }
    });
  });
});
