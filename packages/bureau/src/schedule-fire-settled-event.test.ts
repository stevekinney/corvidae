/**
 * COR-1594 — the persisted shape of the event that records a schedule fire's end: it is additive
 * inside the existing record wrapper, so a history written before it still reads, and it is
 * recorded once per fire.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import type { DurableEventOwner } from '@lostgradient/operative';
import { resolveStorage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createDurableEventHistory, type DurableEventHistory } from './durable-event-history';
import {
  SCHEDULE_FIRE_SETTLED_EVENT_KIND,
  scheduleFireSettledDedupeKey,
  type ScheduleFireSettledPayload,
} from './schedule-fire-settled-event';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const fire: DurableEventOwner = { kind: 'run', id: 'fire-1' };

async function openHistory(): Promise<DurableEventHistory> {
  const storage = await resolveStorage({ type: 'memory' });
  const history = createDurableEventHistory(storage, createManualRuntimeServices());
  cleanups.push(() => history.dispose());
  return history;
}

const settled: ScheduleFireSettledPayload = { runId: 'fire-1', status: 'completed' };

describe('the schedule fire settled event', () => {
  it('is named, so a reader can list it and drop everything else', () => {
    expect(SCHEDULE_FIRE_SETTLED_EVENT_KIND).toBe('schedule.fire.settled');
  });

  it('reads after a history written before it, and the older events read as they did', async () => {
    const history = await openHistory();
    await history.record(fire, 'schedule.completed', { scheduleId: 's-1', runId: 'fire-1' });
    await history.record(fire, SCHEDULE_FIRE_SETTLED_EVENT_KIND, settled, {
      dedupeKey: scheduleFireSettledDedupeKey('fire-1'),
    });

    const page = await history.page(fire);

    expect('events' in page && page.events.map((event) => event.kind)).toEqual([
      'schedule.completed',
      SCHEDULE_FIRE_SETTLED_EVENT_KIND,
    ]);
    expect('events' in page && page.events[1]?.payload).toEqual(settled);
  });

  it('is recorded once for a fire, whichever process settles it', async () => {
    const history = await openHistory();
    const options = { dedupeKey: scheduleFireSettledDedupeKey('fire-1') };

    const first = await history.record(fire, SCHEDULE_FIRE_SETTLED_EVENT_KIND, settled, options);
    const second = await history.record(fire, SCHEDULE_FIRE_SETTLED_EVENT_KIND, settled, options);

    expect(second.cursor).toBe(first.cursor);
    const page = await history.page(fire);
    expect('events' in page && page.events).toHaveLength(1);
  });

  it('keeps each fire on its own key', () => {
    expect(scheduleFireSettledDedupeKey('fire-1')).not.toBe(scheduleFireSettledDedupeKey('fire-2'));
  });
});
