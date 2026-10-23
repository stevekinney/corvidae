/**
 * COR-1527 — a workflow file's schedule belongs to its file: `bureau.schedules.*` reads it but
 * refuses to write it, its owner is the deployment's, and the files put it back after every
 * restart. The engine's scheduler starts only once the documents are registered.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine, Scheduler } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { createAgent } from '@lostgradient/operative';
import type { AgentDefinitions } from './agent-catalog';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function start(
  options?: Parameters<typeof startWorkflowBureau>[0],
): Promise<WorkflowBureauHarness> {
  const harness = await startWorkflowBureau(options);
  cleanups.push(() => harness.dispose());
  return harness;
}

const HOURLY = { trigger: { kind: 'schedule', spec: '1h' } };

async function statusOf(harness: WorkflowBureauHarness, id: string): Promise<string | undefined> {
  const summary = await harness.bureau.getSchedule(id);
  return summary?.status;
}

async function liveIds(harness: WorkflowBureauHarness): Promise<string[] | undefined> {
  const page = await harness.bureau.listSchedules({ status: ['active', 'paused'] });
  return page?.items.map((entry) => entry.id);
}

describe('bureau.schedules on a workflow’s schedule', () => {
  it('lists and reads it, and answers its owner as the deployment’s', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    const id = 'bureau-workflow-schedule:digest:1';

    const all = await harness.bureau.listSchedules();
    expect(await statusOf(harness, id)).toBe('active');
    expect(all?.items.map((entry) => entry.id)).toEqual([id]);
    expect(await harness.bureau.getOwner({ kind: 'schedule', id })).toBe('anonymous:local');
    expect(
      await harness.bureau.getOwner({ kind: 'schedule', id: 'schedule-nobody' }),
    ).toBeUndefined();
  });

  it('refuses to pause, resume, or cancel it, as if it did not exist, and leaves it as it was', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    const id = 'bureau-workflow-schedule:digest:1';
    for (const write of [
      () => harness.bureau.pauseSchedule(id),
      () => harness.bureau.resumeSchedule(id),
      () => harness.bureau.cancelSchedule(id),
    ]) {
      const error = await write().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('NOT_FOUND');
    }
    expect(await statusOf(harness, id)).toBe('active');
  });

  it('still lets an agent schedule be paused, resumed, and cancelled', async () => {
    const harness = await start({
      overrides: {
        agents: {
          default: createAgent({ generate: async () => ({ content: 'tick', toolCalls: [] }) }),
        },
      },
    });
    const summary = await harness.bureau.createSchedule({
      agentName: 'writer',
      input: 'tick',
      spec: '1h',
    });
    expect(await harness.bureau.pauseSchedule(summary!.id)).toBe(true);
    expect(await harness.bureau.resumeSchedule(summary!.id)).toBe(true);
    expect(await harness.bureau.cancelSchedule(summary!.id)).toBe(true);
  });

  it('is changed only by the workflow’s own operations, and a direct cancel through the engine is put back at the next change to the files', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    const engine = harness.bureau.durableEngine()!;
    await engine.cancelSchedule('bureau-workflow-schedule:digest:1');
    await harness.put(
      'digest.json',
      JSON.stringify({ name: 'digest', ...HOURLY, steps: [{ kind: 'sleep', duration: 1 }] }),
    );
    await harness.bureau.workflows?.refresh();
    expect(await liveIds(harness)).toEqual(['bureau-workflow-schedule:digest:2']);
  });

  it('is cancelled with the file, created again under the next generation, and owned by the deployment', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    const hash = harness.bureau.workflows!.list()[0]!.hash!;
    await harness.bureau.workflows!.delete('digest', { expectedHash: hash });
    expect(await statusOf(harness, 'bureau-workflow-schedule:digest:1')).toBe('cancelled');
    await harness.putWorkflow('digest', HOURLY);
    expect(await statusOf(harness, 'bureau-workflow-schedule:digest:2')).toBe('active');
    expect(
      await harness.bureau.getOwner({ kind: 'schedule', id: 'bureau-workflow-schedule:digest:2' }),
    ).toBe('anonymous:local');
  });

  it('is cancelled when the file becomes invalid, and created again under the next generation when it is fixed', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    await harness.put('digest.json', '{');
    await harness.bureau.workflows?.refresh();
    expect(await liveIds(harness)).toEqual([]);
    await harness.putWorkflow('digest', HOURLY);
    expect(await liveIds(harness)).toEqual(['bureau-workflow-schedule:digest:2']);
  });
});

describe('restarting a Bureau over workflow files', () => {
  it('leaves exactly one live schedule after two restarts in a row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-restart-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const storagePath = join(root, 'bureau.sqlite');
    const workflows = join(root, 'workflows');
    const overrides = {
      storage: { type: 'sqlite', path: storagePath },
      durableOwnership: { ownership: 'none' },
    } as const;
    const first = await startWorkflowBureau({ directory: workflows, overrides });
    await first.putWorkflow('digest', HOURLY);
    await first.dispose();

    for (const restart of [1, 2]) {
      const bureau = await startWorkflowBureau({ directory: workflows, overrides });
      const all = await bureau.bureau.listSchedules();
      const live = await bureau.bureau.listSchedules({ status: ['active', 'paused'] });
      expect(
        all?.items.map((entry) => entry.id),
        `restart ${restart}`,
      ).toEqual(['bureau-workflow-schedule:digest:1']);
      expect(live?.items, `restart ${restart}`).toHaveLength(1);
      await bureau.dispose();
    }
  });
});

describe('the engine’s scheduler', () => {
  /** Records the order in which documents are registered and the scheduler is started. */
  function recordEvents(): { events: string[]; restore: () => void } {
    const events: string[] = [];
    const registerSource = Engine.prototype.registerSource;
    const schedulerStart = Scheduler.prototype.start;
    Engine.prototype.registerSource = function (
      this: Engine,
      ...args: Parameters<Engine['registerSource']>
    ) {
      events.push('register');
      return registerSource.apply(this, args);
    };
    Scheduler.prototype.start = function (this: Scheduler) {
      events.push('scheduler-start');
      return schedulerStart.call(this);
    };
    return {
      events,
      restore: () => {
        Engine.prototype.registerSource = registerSource;
        Scheduler.prototype.start = schedulerStart;
      },
    };
  }

  it('starts once the documents of the files already there are registered, and once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-workflow-scheduler-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await Bun.write(join(directory, 'digest.json'), workflowFileText('digest', HOURLY));
    const recorder = recordEvents();
    try {
      const harness = await start({ directory });
      expect(harness.bureau.workflows?.list().map((entry) => entry.state)).toEqual(['ready']);
      expect(recorder.events).toEqual(['register', 'scheduler-start']);
    } finally {
      recorder.restore();
    }
  });

  it('starts as it always did for a Bureau with no workflow directory', async () => {
    const recorder = recordEvents();
    try {
      const bureau = await createBureau({
        agents: {},
        storage: { type: 'memory' },
        durableExecution: true,
      });
      cleanups.push(() => bureau.dispose());
      expect(recorder.events).toEqual(['scheduler-start']);
    } finally {
      recorder.restore();
    }
  });
});
