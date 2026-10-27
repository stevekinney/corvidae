/**
 * COR-1710 — each `retention.*` setting is read by the next maintenance pass (or, for
 * `retention.checkpoints`, by the next task), not fixed when the Bureau was built. Every test
 * moves the manual clock; none waits on wall time.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { DAY_MS, withLiveSettingsBureau } from '../testing/live-settings-bureau.test-support.ts';
import { startTaskFrom } from '../test/task-start-request.ts';

describe('retention.events', () => {
  it('the next maintenance pass advances the floor by the new window', async () => {
    await withLiveSettingsBureau(async ({ at, change, bureau, retentionFloor, settledTask }) => {
      await settledTask();
      // The default window is seven days, so a minute-old event stays.
      at(60_001);
      await bureau.maintain();
      expect(await retentionFloor()).toBe(0);

      await change({ 'retention.events': { olderThan: 60_000 } });
      await bureau.maintain();
      expect(await retentionFloor()).toBeGreaterThan(0);
    });
  });
});

describe('retention.tasks', () => {
  it('the next maintenance pass deletes a settled task older than the new window', async () => {
    await withLiveSettingsBureau(async ({ at, change, bureau, settledTask }) => {
      const taskId = await settledTask();
      at(60_001);
      await bureau.maintain();
      expect(bureau.tasks.detail(taskId)).toBeDefined();

      await change({ 'retention.tasks': { olderThan: 60_000 } });
      await bureau.maintain();
      expect(bureau.tasks.detail(taskId)).toBeUndefined();
    });
  });

  it('reports the new window on the internals the HTTP adapters read', async () => {
    await withLiveSettingsBureau(async ({ change, bureau }) => {
      expect(bureau.internals.taskRetention).toEqual({ olderThan: 30 * DAY_MS });
      await change({ 'retention.tasks': { olderThan: 60_000 } });
      expect(bureau.internals.taskRetention).toEqual({ olderThan: 60_000 });
    });
  });
});

describe('retention.audit', () => {
  it('the next maintenance pass prunes audit records older than the new window', async () => {
    await withLiveSettingsBureau(
      async ({ at, change, bureau, settledTask }) => {
        const taskId = await settledTask();
        const before = await bureau.internals.auditTrail?.query({ runId: taskId });
        expect(before?.length).toBeGreaterThan(0);
        // The floor passes the task's events; with no audit window nothing prunes.
        at(2 * DAY_MS);
        await bureau.maintain();
        expect(await bureau.internals.auditTrail?.query({ runId: taskId })).toEqual(before);

        await change({ 'retention.audit': { olderThan: DAY_MS } });
        await bureau.maintain();
        expect(await bureau.internals.auditTrail?.query({ runId: taskId })).toEqual([]);
      },
      { retention: { events: { olderThan: DAY_MS } } },
    );
  });
});

describe('retention.receipts', () => {
  it('a run-creation receipt expires by the new window', async () => {
    await withLiveSettingsBureau(async ({ at, change, bureau, runtime }) => {
      const locate = { principal: 'alice', agentName: 'default', commandId: 'request-1' } as const;
      const created = await startTaskFrom(bureau, { ...locate, input: 'work' });
      await waitUntil(() => bureau.tasks.detail(created.id)?.status === 'completed', {
        message: 'the task to complete',
      });
      await runtime.deferred.drain();
      expect(await bureau.tasks.receipt(locate)).toMatchObject({ status: 'recorded' });

      at(60_001);
      expect(await bureau.tasks.receipt(locate)).toMatchObject({ status: 'recorded' });

      await change({ 'retention.receipts': { olderThan: 60_000 } });
      expect(await bureau.tasks.receipt(locate)).toMatchObject({ status: 'expired' });
    });
  });
});

describe('retention.checkpoints', () => {
  it('the next task prunes its checkpoint history by the new policy', async () => {
    let step = 0;
    const next = createTool({
      name: 'next',
      description: 'Takes a step.',
      input: z.object({}),
      execute: async () => 'ok',
    });
    await withLiveSettingsBureau(
      async ({ change, bureau, runtime }) => {
        const engine = bureau.durableEngine();
        if (engine === undefined) throw new Error('expected a durable engine');
        const prune = spyOn(engine, 'pruneCheckpoints');
        const run = async (input: string): Promise<string> => {
          step = 0;
          const created = await bureau.tasks.start('stepper', input, { principal: 'alice' });
          await waitUntil(() => bureau.tasks.detail(created.id)?.status === 'completed', {
            message: 'the task to complete',
          });
          await runtime.deferred.drain();
          return created.id;
        };

        await run('before');
        expect(prune).not.toHaveBeenCalled();

        await change({ 'retention.checkpoints': { keepLast: 1 } });
        const after = await run('after');
        await waitUntil(() => prune.mock.calls.some((call) => call[0] === after), {
          message: 'the checkpoint prune',
        });
        expect(prune.mock.calls.find((call) => call[0] === after)?.[1]).toMatchObject({
          keepLast: 1,
        });
      },
      {
        agents: {
          stepper: createAgent({
            generate: async () => {
              step += 1;
              return step < 3
                ? { content: `step ${step}`, toolCalls: [{ name: 'next', arguments: {} }] }
                : { content: 'done', toolCalls: [] };
            },
            toolbox: createToolbox([next]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        } satisfies AgentDefinitions,
        durableGuardrails: { checkpointHistory: 20 },
      },
    );
  });
});
