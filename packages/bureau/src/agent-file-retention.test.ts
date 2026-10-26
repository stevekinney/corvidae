/**
 * COR-1524 — a file agent's snapshot is kept while any run that references it is retained, and
 * pruned after the last one's retention ends. Every window is measured on the Bureau's injected
 * manual clock, which these tests move.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { afterEach, describe, expect, it } from 'bun:test';

import { createSqliteStorageFixture } from './test/storage-fixtures';
import { waitForRunState } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import type { BureauOptions } from './types';
import type { AgentDefinitions } from './agent-catalog';

const ORIGIN = '2026-10-13T00:00:00.000Z';
const ORIGIN_MS = Date.parse(ORIGIN);
const DAY_MS = 86_400_000;

const harnesses: FileBureauHarness[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const FILE = agentFileText({ model: KNOWN_MODEL }, 'Instructions.\n');

async function start(
  overrides: Partial<BureauOptions<AgentDefinitions>> = {},
  script?: () => Promise<string>,
) {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = createSqliteStorageFixture({ runtime });
  cleanups.push(() => fixture.dispose());
  const harness = await startFileBureau({
    ...(script === undefined ? {} : { scripts: { [KNOWN_MODEL]: script } }),
    overrides: {
      runtime,
      storage: fixture.configuration,
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      durableBackgroundTasks: 'manual',
      ...overrides,
    },
  });
  harnesses.push(harness);
  await harness.put('researcher.md', FILE);
  await harness.bureau.agents.refresh();
  return {
    ...harness,
    runtime,
    at: (offsetMs: number) => runtime.setTime(ORIGIN_MS + offsetMs),
  };
}

async function revisionCount(harness: Awaited<ReturnType<typeof start>>): Promise<number> {
  const revisions = await harness.bureau.agents.revisions('researcher');
  return revisions.length;
}

describe('snapshot retention', () => {
  it('keeps a snapshot until the last bureau.run run on it is past task retention', async () => {
    const harness = await start();
    const { bureau, runtime, at } = harness;
    await bureau.run('researcher', 'one').result();
    at(10 * DAY_MS);
    await bureau.run('researcher', 'two').result();
    await runtime.deferred.drain();

    // 30 days after the first settled but only 20 after the second.
    at(30 * DAY_MS + 1);
    await bureau.runDurableMaintenance();
    expect(await revisionCount(harness)).toBe(1);

    // Still inside the window of the second.
    at(40 * DAY_MS);
    await bureau.runDurableMaintenance();
    expect(await revisionCount(harness)).toBe(1);

    at(40 * DAY_MS + 1);
    await bureau.runDurableMaintenance();
    expect(await revisionCount(harness)).toBe(0);
  });

  it('releases the snapshot of a settled scheduler task once it is past task retention (COR-1662)', async () => {
    const harness = await start({ scheduler: { enabled: true, idleDelay: 1 } });
    const { bureau, runtime, at } = harness;
    const task = await bureau.submitSchedulerTask({ agentName: 'researcher', message: 'one' });
    await bureau.awaitSchedulerTask(task.taskId);
    await runtime.deferred.drain();

    at(30 * DAY_MS + 1);
    await bureau.runDurableMaintenance();
    expect(await revisionCount(harness)).toBe(0);
  });

  it('keeps the snapshot of a scheduler task that waits in the queue past the unstarted-run grace (COR-1662)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await start({ scheduler: { enabled: true, idleDelay: 1 } }, async () => {
      await gate;
      return 'first';
    });
    const { bureau, runtime, at } = harness;
    await harness.put('analyst.md', agentFileText({ model: KNOWN_MODEL }, 'Analyst.\n'));
    await bureau.agents.refresh();
    const first = await bureau.submitSchedulerTask({ agentName: 'researcher', message: 'one' });
    const queued = await bureau.submitSchedulerTask({ agentName: 'analyst', message: 'two' });

    // The queued task has no run behind it for longer than the grace, and is still waiting.
    at(11 * 60 * 1000);
    await bureau.runDurableMaintenance();
    expect(await bureau.agents.revisions('analyst')).toHaveLength(1);

    // Both tasks run to the end once the first is released; the manual clock drives the scheduler.
    release();
    await bureau.awaitSchedulerTask(first.taskId);
    for (let turn = 0; turn < 50; turn++) {
      await runtime.advance(5);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (
        bureau.locateSchedulerTask(first.taskId).status === 'terminal' &&
        bureau.locateSchedulerTask(queued.taskId).status === 'terminal'
      ) {
        break;
      }
    }
    expect(bureau.locateSchedulerTask(queued.taskId).status).toBe('terminal');
    await runtime.deferred.drain();
    expect(await bureau.agents.revisions('analyst')).toHaveLength(1);
  });

  it('keeps a snapshot for ever under taskRetention "forever"', async () => {
    const harness = await start({ taskRetention: 'forever' });
    await harness.bureau.run('researcher', 'one').result();
    await harness.runtime.deferred.drain();
    harness.at(3650 * DAY_MS);
    await harness.bureau.runDurableMaintenance();
    expect(await revisionCount(harness)).toBe(1);
  });

  it('releases a session run’s snapshot when its task is deleted, not before', async () => {
    const harness = await start();
    const { bureau, runtime } = harness;
    const first = await bureau.createRun({ message: 'one', agentName: 'researcher' });
    await waitForRunState(bureau, first.id);
    const second = await bureau.createRun({ message: 'two', agentName: 'researcher' });
    await waitForRunState(bureau, second.id);
    await runtime.deferred.drain();

    await bureau.deleteRun(first.id);
    await runtime.deferred.drain();
    expect(await revisionCount(harness)).toBe(1);

    await bureau.deleteRun(second.id);
    await runtime.deferred.drain();
    expect(await revisionCount(harness)).toBe(0);
  });

  it('prunes a session run’s snapshot through the same retention pass that deletes its task', async () => {
    const harness = await start();
    const { bureau, runtime, at } = harness;
    const created = await bureau.createRun({ message: 'one', agentName: 'researcher' });
    await waitForRunState(bureau, created.id);
    await runtime.deferred.drain();
    expect(await revisionCount(harness)).toBe(1);

    at(30 * DAY_MS + 1);
    await bureau.runDurableMaintenance();
    await runtime.deferred.drain();
    expect(bureau.getRun(created.id)).toBeUndefined();
    expect(await revisionCount(harness)).toBe(0);
  });

  it('never prunes the snapshot of a run that has not settled', async () => {
    const gate = Promise.withResolvers<string>();
    const harness = await startGated(gate.promise);
    const { bureau, runtime, at } = harness;
    const running = bureau.run('researcher', 'long');
    await harness.started;

    at(365 * DAY_MS);
    await bureau.runDurableMaintenance();
    expect(await revisionCount(harness)).toBe(1);

    gate.resolve('done');
    await running.result();
    await runtime.deferred.drain();
    at(366 * DAY_MS);
    await bureau.runDurableMaintenance();
    expect(await revisionCount(harness)).toBe(1);
    at(366 * DAY_MS + 365 * DAY_MS);
    await bureau.runDurableMaintenance();
    expect(await revisionCount(harness)).toBe(0);
  });
});

/** A Bureau whose researcher waits on `answer` before it replies. */
async function startGated(answer: Promise<string>) {
  const started = Promise.withResolvers<void>();
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = createSqliteStorageFixture({ runtime });
  cleanups.push(() => fixture.dispose());
  const harness = await startFileBureau({
    scripts: {
      'claude-opus-5-5': async () => {
        started.resolve();
        return answer;
      },
    },
    overrides: {
      runtime,
      storage: fixture.configuration,
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      durableBackgroundTasks: 'manual',
    },
  });
  harnesses.push(harness);
  await harness.put('researcher.md', FILE);
  await harness.bureau.agents.refresh();
  return {
    ...harness,
    runtime,
    started: started.promise,
    at: (offsetMs: number) => runtime.setTime(ORIGIN_MS + offsetMs),
  };
}
