/**
 * COR-2531 — a running task whose model step is on its second or later try has `retrying` set, read
 * from the task record by any process and listed by the `retrying` filter, and it is cleared once
 * the step settles. Operative retries a model step (`generate.retry`); it has no tool-call retry,
 * so a model step is the only step a run retries.
 */
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  openBureau,
  type OpenedBureau,
  rpc,
} from './http/management/management-fixtures.test-support.ts';

const OWNER_KEY = 'tasks-operator-key';

const opened: OpenedBureau[] = [];
afterEach(async () => {
  for (const bureau of opened.splice(0).toReversed()) await bureau.dispose();
});

/** The ids `bureau.tasks.list` answered for `params`. */
async function listedIds(
  handler: OpenedBureau['handler'],
  params: Record<string, unknown>,
): Promise<string[]> {
  const body = await rpc(handler, 'bureau.tasks.list', params, OWNER_KEY);
  const tasks = (body.result?.['tasks'] ?? []) as Array<{ id: string }>;
  return tasks.map((task) => task.id);
}

/** A run whose first model try fails, whose second is held, and whose tool call is held. */
function retryingWorld() {
  const secondTryEntered = Promise.withResolvers<void>();
  const secondTry = Promise.withResolvers<void>();
  const toolEntered = Promise.withResolvers<void>();
  const toolRelease = Promise.withResolvers<void>();
  let generations = 0;
  const generate: GenerateFunction = async () => {
    generations += 1;
    if (generations === 1) throw new Error('rate limited');
    if (generations === 2) {
      secondTryEntered.resolve();
      await secondTry.promise;
      return { content: '', toolCalls: [{ name: 'hang', arguments: {} }] };
    }
    return { content: 'Done.', toolCalls: [] };
  };
  const hang = createTool({
    name: 'hang',
    description: 'holds until released',
    input: z.object({}),
    async execute() {
      toolEntered.resolve();
      await toolRelease.promise;
      return 'ok';
    },
  });
  return {
    agent: createAgent({
      name: 'retrier',
      generate,
      retry: { attempts: 3 },
      toolbox: createToolbox([hang]) as unknown as Toolbox,
      stopWhen: stopWhen.noToolCalls(),
    }),
    secondTryEntered: secondTryEntered.promise,
    releaseSecondTry: () => secondTry.resolve(),
    toolEntered: toolEntered.promise,
    releaseTool: () => toolRelease.resolve(),
  };
}

describe('a model step on its second try (COR-2531)', () => {
  for (const durable of [false, true]) {
    it(`AC3, AC4: is retrying during the second try, listed by the filter, and cleared once the step settles (${durable ? 'durably' : 'in process'})`, async () => {
      const world = retryingWorld();
      const storage = new MemoryStorage();
      const bureauOptions = { durable, maintenance: 'manual' } as const;
      const holder = await openBureau({ agents: { retrier: world.agent }, storage, bureauOptions });
      opened.push(holder);
      // A process that does not hold the run reads the same record.
      const peer = await openBureau({ storage, bureauOptions });
      opened.push(peer);
      const quick = await holder.bureau.tasks.start('retrier', 'Go.');
      await world.secondTryEntered;

      await waitUntil(async () => (await peer.bureau.tasks.get(quick.id))?.retrying !== null, {
        message: 'the second try is recorded',
      });
      const during = await peer.bureau.tasks.get(quick.id);
      expect(during?.status).toBe('working');
      expect(during?.retrying).toEqual({ label: 'model', attempt: 2 });
      expect(await listedIds(peer.handler, { retrying: true })).toEqual([quick.id]);
      expect(await listedIds(peer.handler, { retrying: false })).toEqual([]);

      // The step settles (it answered with a tool call): the task is still working, and no longer retrying.
      world.releaseSecondTry();
      await world.toolEntered;
      await waitUntil(async () => (await peer.bureau.tasks.get(quick.id))?.retrying === null, {
        message: 'the retry is cleared when the step settles',
      });
      const after = await peer.bureau.tasks.get(quick.id);
      expect(after?.status).toBe('working');
      expect((await peer.bureau.internals.taskRegistry.record(quick.id))?.retrying).toBeUndefined();
      expect(await listedIds(peer.handler, { retrying: true })).toEqual([]);
      expect(await listedIds(peer.handler, { retrying: false })).toEqual([quick.id]);

      world.releaseTool();
      await quick.result();
    });
  }

  it('a run that ends while a step is retrying leaves no retry on the settled task', async () => {
    const stuck = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let generations = 0;
    const generate: GenerateFunction = async () => {
      generations += 1;
      if (generations === 1) throw new Error('rate limited');
      entered.resolve();
      await stuck.promise;
      return { content: 'late', toolCalls: [] };
    };
    const agent = createAgent({
      name: 'retrier',
      generate,
      retry: { attempts: 3 },
      stopWhen: stopWhen.noToolCalls(),
    });
    const holder = await openBureau({ agents: { retrier: agent } });
    opened.push(holder);
    const task = await holder.bureau.tasks.start('retrier', 'Go.');
    await entered.promise;
    await waitUntil(async () => (await holder.bureau.tasks.get(task.id))?.retrying !== null);

    await holder.bureau.tasks.cancel(task.id);
    stuck.resolve();
    await waitUntil(async () => (await holder.bureau.tasks.get(task.id))?.status === 'canceled');
    await holder.bureau.internals.taskRegistry.flush();
    expect((await holder.bureau.tasks.get(task.id))?.retrying).toBeNull();
    expect((await holder.bureau.internals.taskRegistry.record(task.id))?.retrying).toBeUndefined();
  });
});
