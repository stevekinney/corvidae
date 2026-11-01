/**
 * COR-1987 — a task's pending wakeup is kept on its record and read back as `TaskView.wakeAt`, so a
 * reloaded chat can show "Will continue at …" for a run that is asleep. The run's own announcement
 * (`schedule.wakeup`) is live-only: a stream that attaches after it never sees it, and a sleeping run
 * outlives the process that announced it.
 */
import { MemoryStorage } from '@lostgradient/storage';
import { createAgent, createMockGenerate, stopWhen, type Toolbox } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';

describe('a task that scheduled a wakeup (COR-1987)', () => {
  it('reads wakeAt as the time the run announced while it sleeps, and null once it has finished', async () => {
    const generate = createMockGenerate([
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'scheduleWakeup', arguments: { in: '6h' } }],
      },
      { content: 'resumed after the wakeup fired', toolCalls: [] },
    ]);
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate,
          toolbox: createToolbox([]) as unknown as Toolbox,
          stopWhen: stopWhen.some(stopWhen.toolCalled('scheduleWakeup'), stopWhen.noToolCalls()),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
      maintenance: 'manual',
    });
    const announced: { runId: string; wakeAt: number }[] = [];
    bureau.addEventListener('action', (event) => {
      if (event.action.type !== 'schedule.wakeup') return;
      const { wakeAt } = event.action.detail as { wakeAt: number };
      announced.push({ runId: event.action.runId, wakeAt });
    });

    const wakeAtOf = async (taskId: string) => {
      const task = await bureau.tasks.get(taskId);
      return task?.wakeAt;
    };

    try {
      const run = await bureau.tasks.start('default', 'sleep for six hours');
      await waitUntil(() => announced.length === 1, { message: 'the wakeup is announced' });

      // The task id is the run id the announcement names: a reader joins them on it.
      expect(announced[0]?.runId).toBe(run.id);
      await waitUntil(async () => (await wakeAtOf(run.id)) != null, {
        message: 'the wakeup is on the task',
      });
      const sleeping = await bureau.tasks.get(run.id);
      expect(sleeping?.id).toBe(run.id);
      expect(sleeping?.status).toBe('working');
      expect(sleeping?.wakeAt).toBe(new Date(announced[0]!.wakeAt).toISOString());
      // `tasks.list` returns it too.
      const listed = await bureau.tasks.list({ principal: 'test', limit: 10 });
      expect(listed.tasks.map((task) => [task.id, task.wakeAt])).toEqual([
        [run.id, new Date(announced[0]!.wakeAt).toISOString()],
      ]);

      // Drive the scheduler past the deadline: the run wakes, takes its last step and ends.
      const deadline = Date.parse('2099-01-01T00:00:00.000Z');
      await waitUntil(
        async () => {
          await bureau.maintain(deadline);
          const task = await bureau.tasks.get(run.id);
          return task?.status === 'completed';
        },
        { message: 'the run completes after the wakeup fires' },
      );

      expect(await wakeAtOf(run.id)).toBeNull();
    } finally {
      bureau.dispose();
    }
  });
});
