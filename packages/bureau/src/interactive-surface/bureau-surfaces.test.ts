/**
 * COR-1631 — interactive surfaces on a real Bureau: a surface's latest
 * revision survives a restart, and cancelling its task freezes it and resolves
 * the task's cleanup evidence.
 */
import { createDefaultRuntimeServices, createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { waitForCondition } from '../test';
import { retireSettledTasks, SHORT_TASK_RETENTION } from '../testing/run-retirement.test-support';
import { createSqliteStorageFixture } from '../test/storage-fixtures';
import type { Bureau, BureauOptions } from '../types';
import { INTERACTIVE_SURFACE_CONTRACT_VERSION } from './types';

const version = INTERACTIVE_SURFACE_CONTRACT_VERSION;
const OWNER = 'api-key:alice';

/** A model call that waits until the run is aborted, so the task stays open. */
const parks: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

function open(
  path: ReturnType<typeof createSqliteStorageFixture>['configuration'],
  extra: Partial<BureauOptions<AgentDefinitions>> = {},
) {
  return createBureau<AgentDefinitions>({
    id: 'surface-bureau',
    agents: {
      worker: createAgent({ generate: parks }),
    },
    storage: path,
    durable: true,
    ...extra,
  });
}

async function startTask(bureau: Bureau<AgentDefinitions>): Promise<string> {
  const run = await bureau.tasks.start('worker', 'hold', { principal: OWNER });
  await waitForCondition(
    async () => (await bureau.internals.taskRegistry.record(run.id)) !== undefined,
    'record',
  );
  return run.id;
}

function surfacesOf(bureau: Bureau<AgentDefinitions>) {
  const surfaces = bureau.surfaces;
  if (surfaces === undefined) throw new Error('a persistent Bureau has surfaces');
  return surfaces;
}

async function createForm(bureau: Bureau<AgentDefinitions>, taskId: string) {
  const record = await bureau.internals.taskRegistry.record(taskId);
  if (record === undefined) throw new Error('the task has a record');
  return surfacesOf(bureau).create(
    {
      type: 'surface.create',
      contractVersion: version,
      commandId: 'create-1',
      taskId,
      surfaceId: 'confirm',
      summary: 'Confirm the deployment window.',
      representation: {
        kind: 'input-form',
        schema: { type: 'object', properties: { window: { type: 'string' } } },
      },
      actions: [
        {
          name: 'submit',
          intent: 'submit',
          continuation: { type: 'signal', sessionId: record.contextId, signalName: 'window' },
        },
      ],
    },
    { principal: OWNER },
  );
}

describe('interactive surfaces on a Bureau', () => {
  it('reads a surface’s latest revision back after a restart', async () => {
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    try {
      const first = await open(fixture.storage);
      let taskId: string;
      try {
        taskId = await startTask(first);
        expect(await createForm(first, taskId)).toMatchObject({ outcome: 'accepted' });
        const updated = await surfacesOf(first).update(
          {
            type: 'surface.update',
            contractVersion: version,
            commandId: 'update-1',
            taskId,
            surfaceId: 'confirm',
            baseRevision: 1,
            data: { window: 'tonight' },
          },
          { principal: OWNER },
        );
        expect(updated).toMatchObject({ outcome: 'accepted', surface: { revision: 2 } });
      } finally {
        await first.shutdown({ policy: 'abort' });
      }

      const second = await open(await fixture.reopen());
      try {
        const receipt = await surfacesOf(second).snapshot(
          { type: 'surface.snapshot', contractVersion: version, taskId, surfaceId: 'confirm' },
          { principal: OWNER },
        );
        // The shutdown aborted the run, so the surface reads back frozen at its latest content.
        expect(receipt).toMatchObject({
          outcome: 'found',
          surface: { data: { window: 'tonight' }, dataRevision: 2, owner: OWNER },
        });
        // Revision 2 is the update; the run the shutdown aborted froze the surface at revision 3.
        expect(receipt.outcome === 'found' && receipt.surface.revision).toBe(3);
        expect(receipt.outcome === 'found' && receipt.surface.liveness).toBe('frozen');
      } finally {
        await second.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('freezes a cancelled task’s surfaces and resolves its cleanup evidence', async () => {
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    const bureau = await open(fixture.storage);
    try {
      const taskId = await startTask(bureau);
      await createForm(bureau, taskId);
      const evidence = surfacesOf(bureau).closed(taskId);

      await bureau.internals.taskRegistry.cancel(taskId, 0);

      expect(await evidence).toEqual({ status: 'completed' });
      const receipt = await surfacesOf(bureau).snapshot(
        { type: 'surface.snapshot', contractVersion: version, taskId, surfaceId: 'confirm' },
        { principal: OWNER },
      );
      expect(receipt).toMatchObject({
        outcome: 'found',
        surface: {
          state: 'closed',
          liveness: 'frozen',
          closeResult: { reason: 'cancelled' },
          representation: { kind: 'input-form' },
        },
      });
      const page = await bureau.tasks.events(taskId, { limit: 200 });
      const kinds = 'events' in page ? page.events.map((event) => event.kind) : [];
      expect(kinds.filter((kind) => kind.startsWith('surface.'))).toEqual([
        'surface.created',
        'surface.frozen',
      ]);
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });

  it('keeps a run whose surfaces could not be removed, so the next retention pass retries', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    const bureau = await open(fixture.storage, { runtime, ...SHORT_TASK_RETENTION });
    try {
      const taskId = await startTask(bureau);
      await createForm(bureau, taskId);
      await bureau.internals.taskRegistry.cancel(taskId, 0);
      await waitForCondition(async () => {
        const run = await bureau.tasks.detail(taskId);
        return run?.status !== 'running';
      }, 'the run stops');
      const surfaces = surfacesOf(bureau);
      const removeTask = surfaces.removeTask.bind(surfaces);
      Reflect.set(surfaces, 'removeTask', async () => {
        throw new Error('storage unavailable');
      });

      await retireSettledTasks(bureau, runtime);
      expect(await bureau.tasks.detail(taskId)).toBeDefined();

      Reflect.set(surfaces, 'removeTask', removeTask);
      await retireSettledTasks(bureau, runtime);
      expect(await bureau.tasks.detail(taskId)).toBeUndefined();
      expect(
        await surfaces.snapshot(
          { type: 'surface.snapshot', contractVersion: version, taskId, surfaceId: 'confirm' },
          { principal: OWNER },
        ),
      ).toMatchObject({ reason: 'not-found' });
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });

  it('refuses a review continuation the task does not hold, however well formed', async () => {
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    const bureau = await open(fixture.storage);
    try {
      const taskId = await startTask(bureau);
      const receipt = await surfacesOf(bureau).create(
        {
          type: 'surface.create',
          contractVersion: version,
          commandId: 'create-review',
          taskId,
          surfaceId: 'approve',
          summary: 'Approve the call.',
          representation: { kind: 'input-form', schema: { type: 'object' } },
          actions: [
            {
              name: 'approve',
              intent: 'approve',
              continuation: { type: 'review', reviewId: `approval:${taskId}:call-1` },
            },
          ],
        },
        { principal: OWNER },
      );
      expect(receipt).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });

  it('has no surfaces without persistent storage', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: { worker: createAgent({ generate: parks }) },
    });
    try {
      expect(bureau.surfaces).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });
});
