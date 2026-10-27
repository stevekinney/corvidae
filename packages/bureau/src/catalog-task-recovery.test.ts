/**
 * COR-1481 — what boot recovery does for the task of a durable `bureau.run()` run.
 *
 * - A catalog run that is over, and whose task retention removed, stays removed across a boot.
 * - A catalog run still in flight with no task record (the admission write was lost) gets
 *   exactly one, dated from the durable run.
 * - A catalog run recovered in flight settles its task when it ends, in the new process.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { createAskingAgent, finishes } from './test/task-record-crash-agent';
import type { Bureau } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const fixtures: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  // The Bureau that took over disposes first: the one it took over from is still running.
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function newFixture() {
  const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
  fixtures.push(fixture);
  return fixture;
}

async function open(fixture: ReturnType<typeof newFixture>) {
  const bureau = await createBureau<AgentDefinitions>({
    id: 'catalog-task-recovery',
    agents: {
      asker: createAskingAgent(),
      answerer: createAgent({ generate: finishes, toolbox: createToolbox([]) }),
      default: createAgent({
        generate: finishes,
        toolbox: createToolbox([]),
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      }),
    },
    storage: fixture.configuration,
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  bureaus.push(bureau);
  return bureau;
}

describe('a catalog task across a boot', () => {
  it('stays removed when retention removed it, and its message text is not written again', async () => {
    const fixture = newFixture();
    const first = await open(fixture);
    const run = first.run('answerer', 'EXPIRED-QUESTION', { principal: 'api-key:alice' });
    await run.result();
    await waitForCondition(async () => {
      const task = await first.internals.taskRegistry.get(run.id);
      return task?.status === 'completed';
    }, 'settled');
    await first.internals.taskRegistry.remove(run.id);
    await first.dispose();
    bureaus.splice(bureaus.indexOf(first), 1);

    const second = await open(fixture);
    await second.waitForRecovery?.();

    expect(await second.internals.taskRegistry.record(run.id)).toBeUndefined();
    expect(await second.internals.taskRegistry.history(run.id)).toBeUndefined();
  });

  it('gets exactly one record, dated from the durable run, when it is in flight and was never recorded', async () => {
    const fixture = newFixture();
    const crashed = await open(fixture);
    const run = crashed.run('asker', 'which environment?', { principal: 'api-key:alice' });
    await waitForCondition(
      () => crashed.reviews.list().some((review) => review.runId === run.id),
      'the run never parked',
    );
    await waitForCondition(
      async () => (await crashed.internals.taskRegistry.record(run.id)) !== undefined,
      'recorded',
    );
    // The admission write is lost: the record is gone while the durable run goes on.
    await crashed.internals.taskRegistry.remove(run.id);
    // This Bureau is not disposed: a graceful shutdown would cancel the parked run.

    const restarted = await open(fixture);
    await restarted.waitForRecovery?.();

    const record = await restarted.internals.taskRegistry.record(run.id);
    const durable = await restarted.tasks.workflow(run.id);
    expect(record).toMatchObject({ taskId: run.id, owner: 'api-key:alice', agentName: 'asker' });
    expect(record?.createdAt).toBe(new Date(durable!.createdAt).toISOString());
    const listed = await restarted.internals.taskRegistry.enumerate({ limit: 50, offset: 0 });
    expect(listed.tasks.filter((task) => task.id === run.id)).toHaveLength(1);
  });

  it('settles the task of a catalog run that was in flight across the restart and ends after it', async () => {
    const fixture = newFixture();
    const crashed = await open(fixture);
    const run = crashed.run('asker', 'which environment?', { principal: 'api-key:alice' });
    await waitForCondition(
      () => crashed.reviews.list().some((review) => review.runId === run.id),
      'the run never parked',
    );
    const restarted = await open(fixture);
    await restarted.waitForRecovery?.();
    await waitForCondition(
      () => restarted.reviews.list().some((review) => review.runId === run.id),
      'the recovered run never parked again',
    );
    const [review] = restarted.reviews.list().filter((candidate) => candidate.runId === run.id);

    await restarted.reviews.resolve({
      id: review!.id,
      decision: 'approve',
      principal: 'api-key:alice',
      payload: 'staging',
    });
    await restarted.tasks.wait(run.id);

    await waitForCondition(async () => {
      const task = await restarted.internals.taskRegistry.get(run.id);
      return task?.status === 'completed';
    }, 'the task never settled');
    const record = await restarted.internals.taskRegistry.record(run.id);
    expect(record?.settled).toMatchObject({ status: 'completed' });
    expect(record?.settled?.answer?.text).toBe('thanks');
  });
});
