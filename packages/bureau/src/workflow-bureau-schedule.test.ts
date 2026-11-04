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
import { MemoryStorage } from '@lostgradient/storage';
import { createSqliteStorageFixture } from './test/storage-fixtures';

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
  const summary = await harness.bureau.schedules.get(id);
  return summary?.status;
}

async function liveIds(harness: WorkflowBureauHarness): Promise<string[] | undefined> {
  const page = await harness.bureau.schedules.list({ status: ['active', 'paused'] });
  return page?.items.map((entry) => entry.id);
}

describe('bureau.schedules on a workflow’s schedule', () => {
  it('lists and reads it, and answers its owner as the deployment’s', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    const id = 'bureau-workflow-schedule:digest:1';

    const all = await harness.bureau.schedules.list();
    expect(await statusOf(harness, id)).toBe('active');
    expect(all?.items.map((entry) => entry.id)).toEqual([id]);
    expect(await harness.bureau.ownerOf({ kind: 'schedule', id })).toBe('anonymous:local');
    expect(
      await harness.bureau.ownerOf({ kind: 'schedule', id: 'schedule-nobody' }),
    ).toBeUndefined();
  });

  it('refuses to pause, resume, or cancel it, as if it did not exist, and leaves it as it was', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    const id = 'bureau-workflow-schedule:digest:1';
    for (const write of [
      () => harness.bureau.schedules.pause(id),
      () => harness.bureau.schedules.resume(id),
      () => harness.bureau.schedules.cancel(id),
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
    const summary = await harness.bureau.schedules.create({
      agentName: 'default',
      input: 'tick',
      spec: '1h',
    });
    expect(await harness.bureau.schedules.pause(summary!.id)).toBe(true);
    expect(await harness.bureau.schedules.resume(summary!.id)).toBe(true);
    expect(await harness.bureau.schedules.cancel(summary!.id)).toBe(true);
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
      await harness.bureau.ownerOf({ kind: 'schedule', id: 'bureau-workflow-schedule:digest:2' }),
    ).toBe('anonymous:local');
  });
});

describe('a workflow file that stops parsing (COR-2009)', () => {
  const id = 'bureau-workflow-schedule:digest:1';

  it('keeps the schedule its last good version made, and reports that the workflow can’t load', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    const before = await harness.bureau.schedules.get(id);
    await harness.put('digest.json', '{');
    await harness.bureau.workflows?.refresh();

    expect(await liveIds(harness)).toEqual([id]);
    const after = await harness.bureau.schedules.get(id);
    expect(after?.cronExpression ?? after?.intervalMs).toBe(
      before?.cronExpression ?? before?.intervalMs,
    );
    expect(await harness.bureau.schedules.blocker(id)).toEqual({
      kind: 'workflow-cannot-load',
      workflow: 'digest',
      message: expect.any(String) as unknown as string,
      status: 'active',
    });
  });

  it('holds it paused in the engine, with its next fire kept, so it starts nothing', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    await harness.put('digest.json', '{');
    await harness.bureau.workflows?.refresh();

    const engine = harness.bureau.durableEngine()!;
    const held = await engine.getSchedule(id);
    expect(held?.status).toBe('paused');
    expect(held?.nextFireAt).not.toBeNull();
    // A workflow file's schedule is never started by hand either.
    const runNow = await harness.bureau.schedules.runNow(id).catch((thrown: unknown) => thrown);
    expect((runNow as BureauError).code).toBe('NOT_FOUND');
    const instances = await engine.list({ type: 'digest' });
    expect(instances.items).toEqual([]);
  });

  it('resumes it, under the same id and with no blocker, when the file parses again', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    await harness.put('digest.json', '{');
    await harness.bureau.workflows?.refresh();
    await harness.putWorkflow('digest', HOURLY);

    expect(await liveIds(harness)).toEqual([id]);
    expect(await statusOf(harness, id)).toBe('active');
    expect(await harness.bureau.schedules.blocker(id)).toBeUndefined();
  });

  it('keeps a schedule the last good version paused paused, and reports it as paused', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', { ...HOURLY, paused: true });
    await harness.put('digest.json', '{');
    await harness.bureau.workflows?.refresh();
    const blocker = await harness.bureau.schedules.blocker(id);
    expect(blocker?.status).toBe('paused');
    await harness.putWorkflow('digest', { ...HOURLY, paused: true });
    expect(await statusOf(harness, id)).toBe('paused');
  });

  it('still cancels the schedule when the file is deleted while it can’t load', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', HOURLY);
    await harness.put('digest.json', '{');
    await harness.bureau.workflows?.refresh();
    await rm(join(harness.directory, 'digest.json'));
    await harness.bureau.workflows?.refresh();
    expect(await liveIds(harness)).toEqual([]);
  });
});

describe('restarting a Bureau over workflow files', () => {
  it('leaves exactly one live schedule after two restarts in a row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-restart-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const storageFixture = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
    // Closed after the Bureaus: the cleanups dispose those first.
    cleanups.push(() => storageFixture.dispose());
    const workflows = join(root, 'workflows');
    const overrides = {
      storage: storageFixture.storage,
      durableOwnership: { ownership: 'none' },
    } as const;
    const first = await startWorkflowBureau({ directory: workflows, overrides });
    await first.putWorkflow('digest', HOURLY);
    await first.dispose();

    for (const restart of [1, 2]) {
      const bureau = await startWorkflowBureau({ directory: workflows, overrides });
      const all = await bureau.bureau.schedules.list();
      const live = await bureau.bureau.schedules.list({ status: ['active', 'paused'] });
      expect(
        all?.items.map((entry) => entry.id),
        `restart ${restart}`,
      ).toEqual(['bureau-workflow-schedule:digest:1']);
      expect(live?.items, `restart ${restart}`).toHaveLength(1);
      await bureau.dispose();
    }
  });
});

describe('restarting a Bureau over a workflow file that stopped parsing (COR-2009)', () => {
  it('still holds the schedule as active, with its blocker, and resumes it once the file parses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-hold-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const storageFixture = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
    cleanups.push(() => storageFixture.dispose());
    const workflows = join(root, 'workflows');
    const overrides = {
      storage: storageFixture.storage,
      durableOwnership: { ownership: 'none' },
    } as const;
    const id = 'bureau-workflow-schedule:digest:1';
    const first = await startWorkflowBureau({ directory: workflows, overrides });
    await first.putWorkflow('digest', HOURLY);
    await first.put('digest.json', '{');
    await first.bureau.workflows?.refresh();
    await first.dispose();

    const second = await startWorkflowBureau({ directory: workflows, overrides });
    const blocker = await second.bureau.schedules.blocker(id);
    expect(blocker?.status).toBe('active');
    const inEngine = await second.bureau.durableEngine()!.getSchedule(id);
    expect(inEngine?.status).toBe('paused');
    await second.putWorkflow('digest', HOURLY);
    expect(await statusOf(second, id)).toBe('active');
    expect(await second.bureau.schedules.blocker(id)).toBeUndefined();
    await second.dispose();
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
        storage: new MemoryStorage(),
        durable: true,
      });
      cleanups.push(() => bureau.dispose());
      expect(recorder.events).toEqual(['scheduler-start']);
    } finally {
      recorder.restore();
    }
  });
});
