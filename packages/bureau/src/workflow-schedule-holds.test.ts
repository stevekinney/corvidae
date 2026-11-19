/**
 * COR-2546 — the hold records of a workflow's schedules: the revision a caller's schedule was
 * paused at rides in the record, and a record written before it reads back without one.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import {
  createWorkflowScheduleHolds,
  WORKFLOW_SCHEDULE_HOLD_KEY_PREFIX,
} from './workflow-schedule-holds.ts';

const NOW = '2026-11-19T00:00:00.000Z';

describe('a hold', () => {
  it('keeps the revision a schedule was paused at, and a file’s own hold has none', async () => {
    const holds = createWorkflowScheduleHolds({ nowISO: () => NOW });

    await holds.hold('caller#schedule-1', 'schedule-1', 4);
    await holds.hold('digest', 'bureau-workflow-schedule:digest:1');

    expect(await holds.held('caller#schedule-1')).toEqual({
      schemaVersion: 1,
      scheduleId: 'schedule-1',
      heldAt: NOW,
      revision: 4,
    });
    expect(await holds.held('digest')).toEqual({
      schemaVersion: 1,
      scheduleId: 'bureau-workflow-schedule:digest:1',
      heldAt: NOW,
    });
    await holds.release('caller#schedule-1');
    expect(await holds.held('caller#schedule-1')).toBeUndefined();
  });

  it('reads a record with no revision, or one that is not a whole number, as having none', async () => {
    const store = textValueStore(new MemoryStorage());
    const holds = createWorkflowScheduleHolds({ store, nowISO: () => NOW });
    const record = { schemaVersion: 1, scheduleId: 's', heldAt: NOW };
    await store.set(`${WORKFLOW_SCHEDULE_HOLD_KEY_PREFIX}a`, JSON.stringify(record));
    await store.set(
      `${WORKFLOW_SCHEDULE_HOLD_KEY_PREFIX}b`,
      JSON.stringify({ ...record, revision: 1.5 }),
    );

    expect(await holds.held('a')).toEqual(record);
    expect(await holds.held('b')).toEqual(record);
  });
});
