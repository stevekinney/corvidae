/**
 * COR-1925 — a schedule tick commits its run with the schedule that names it, and Bureau records the
 * fire (its task admission and its `schedule.fired` entry) once that batch has committed. A process
 * that dies in between leaves a committed run whose fire Bureau has recorded nothing about; the
 * Bureau that recovers it rebuilds the fire from the schedule and occurrence the run carries, so the
 * admission and the entry are written once, and the tick that follows starts nothing a second time.
 */
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  auditRecordsOf,
  createScheduleFireHarness,
  durableStatus,
  holdingWrites,
  pollUntil,
} from './schedule-fire-fixtures.test-support';
import { TASK_RECORD_KEY_PREFIX } from './task-registry';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

const generate: GenerateFunction = async () => ({ content: 'checked in', toolCalls: [] });

describe('a process that dies after a tick committed and before Bureau recorded the fire', () => {
  it('records the fire’s admission and its audit entry once when another Bureau recovers it', async () => {
    const path = harness.nextDatabasePath();
    // The first write of the fire's services is its task admission: held, the process is dead there.
    const crash = holdingWrites(TASK_RECORD_KEY_PREFIX);
    harness.onDispose(() => crash.release());
    const first = await harness.open({
      storage: await harness.sqliteStorage(path, (storage) => crash.wrap(storage)),
      agents: { default: createAgent({ generate }) },
    });
    const created = await first.schedules.create({
      agentName: 'default',
      input: 'check in',
      spec: '1m',
      principal: OWNER.alice,
    });
    const occurrence = created?.nextFireAt;
    if (created === undefined || occurrence === null || occurrence === undefined) {
      throw new Error('The schedule has no first occurrence.');
    }
    crash.arm();
    void first.maintain(occurrence);
    await crash.reached;

    // The tick's batch is whole, and the fire has no task and no audit entry.
    const committed = await first.schedules.get(created.id);
    const fireId = committed?.currentWorkflowId;
    if (fireId === undefined) throw new Error('The tick committed no run.');
    expect(committed?.lastFireAt).toBe(occurrence);
    expect(await first.tasks.get(fireId)).toBeUndefined();

    const recovered = await harness.open({
      storage: await harness.sqliteStorage(path),
      agents: { default: createAgent({ generate }) },
    });
    await pollUntil(
      async () => ((await durableStatus(recovered, fireId)) === 'completed' ? true : undefined),
      'the recovered fire to complete',
    );
    // The tick that follows the restart finds the occurrence fired and starts nothing.
    await recovered.maintain(occurrence);

    const task = await recovered.tasks.get(fireId);
    expect(task).toMatchObject({
      owner: OWNER.alice,
      origin: { kind: 'schedule', scheduleId: created.id, fireId },
    });
    const fires = await recovered.tasks.list({
      principal: OWNER.alice,
      owner: OWNER.alice,
      origin: 'schedule',
      limit: 10,
    });
    expect(fires.tasks.map((entry) => entry.id)).toEqual([fireId]);
    const fired = await auditRecordsOf(recovered, fireId, 'schedule.fired');
    expect(fired.map((entry) => entry.principal)).toEqual(['system:scheduler']);
    const after = await recovered.schedules.get(created.id);
    expect(after?.lastFireAt).toBe(occurrence);
  });
});
