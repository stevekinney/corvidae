/**
 * COR-1594, correction 2 — the boot pass that repairs a fire's missing `schedule.fire.settled` event
 * looks only inside the event retention window. Retention removes an event together with its
 * deduplication marker, so a fire settled before the cutoff has no marker and no event by design,
 * and announcing it again at every boot would record one fire's end once per retention cycle. A fire
 * inside the window whose append never landed is still repaired, and its event is dated where the
 * fire ended, not at the boot.
 *
 * Every Bureau here runs on a manual runtime, so the days pass without a wall-clock wait.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import type { GenerateFunction } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  fireOnce,
  holdingWrites,
  pollUntil,
} from './schedule-fire-fixtures.test-support';
import { SCHEDULE_FIRE_SETTLED_EVENT_KIND } from './schedule-fire-settled-event';
import { fireBureauOptions, forgetDrivenRuntimes } from './schedule-fire-stream.test-support';
import type { Bureau, BureauOptions } from './types';

const harness = createScheduleFireHarness();

afterEach(async () => {
  forgetDrivenRuntimes();
  await harness.dispose();
});

const DAY = 86_400_000;
const ORIGIN = Date.parse('2026-01-01T00:00:00.000Z');

const completes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

/** A Bureau on `path` whose manual runtime starts at `at`. */
async function openAt(
  path: string,
  seed: string,
  at: number,
  extra: Partial<BureauOptions> = {},
  wrap?: Parameters<typeof harness.sqliteStorage>[1],
) {
  const runtime = createManualRuntimeServices({
    identifierSeed: seed,
    origin: new Date(at).toISOString(),
  });
  const bureau = await harness.open({
    ...fireBureauOptions(completes, seed),
    runtime,
    ...extra,
    storage: await harness.sqliteStorage(path, wrap),
  });
  return { bureau, runtime };
}

/** The fire's settled events the history retains, reading past a retention gap. */
async function settledEventsOf(bureau: Bureau, fireId: string) {
  const owner = { kind: 'run', id: fireId } as const;
  let page = await bureau.eventHistory(owner);
  if ('outcome' in page && page.outcome === 'gap') {
    page = await bureau.eventHistory(owner, {
      since: String(Math.max(page.firstRetainedSequence - 1, -1)),
    });
  }
  if (!('events' in page)) return [];
  return page.events.filter((event) => event.kind === SCHEDULE_FIRE_SETTLED_EVENT_KIND);
}

async function settled(bureau: Bureau, fireId: string): Promise<void> {
  await pollUntil(async () => {
    const view = await bureau.tasks.get(fireId);
    return view?.status === 'completed' ? true : undefined;
  }, 'the fire to settle');
}

/** A holder whose append of the settled event is held for good, as if its process died there. */
async function settleWithoutEvent(path: string) {
  const hold = holdingWrites(SCHEDULE_FIRE_SETTLED_EVENT_KIND);
  harness.onDispose(() => hold.release());
  const holder = await openAt(path, 'holder', ORIGIN, {}, (storage) => hold.wrap(storage));
  hold.arm();
  const { fireId } = await fireOnce(holder.bureau, OWNER.alice);
  await hold.reached;
  await settled(holder.bureau, fireId);
  return { fireId, hold };
}

async function letGoOfTheDeadAppend(hold: { release(): void }): Promise<void> {
  hold.release();
  for (let turn = 0; turn < 10; turn += 1) await yieldToPortableEventLoop();
}

describe('the boot pass after event retention removed a fire’s settled event', () => {
  it('appends nothing for a fire settled before the cutoff, boot after boot', async () => {
    const path = harness.nextDatabasePath();
    const first = await openAt(path, 'boot-0', ORIGIN);
    const { fireId } = await fireOnce(first.bureau, OWNER.alice);
    await settled(first.bureau, fireId);
    await pollUntil(async () => {
      const recorded = await settledEventsOf(first.bureau, fireId);
      return recorded.length === 1 ? true : undefined;
    }, 'the settled event');

    let current = first;
    for (let round = 1; round <= 3; round += 1) {
      const at = ORIGIN + round * 8 * DAY;
      // Event retention (7 days) passes; task retention (30 days) does not.
      current.runtime.setTime(at);
      await current.bureau.runDurableMaintenance(ORIGIN);
      expect(await settledEventsOf(current.bureau, fireId)).toHaveLength(0);
      const view = await current.bureau.tasks.get(fireId);
      expect(view?.status).toBe('completed');

      current = await openAt(path, `boot-${round}`, at);

      expect(await settledEventsOf(current.bureau, fireId)).toHaveLength(0);
    }
  });

  it('still repairs a fire inside the window whose append never landed, dated where it ended', async () => {
    const path = harness.nextDatabasePath();
    const { fireId, hold } = await settleWithoutEvent(path);
    const twoDaysLater = ORIGIN + 2 * DAY;

    const restart = await openAt(path, 'restart', twoDaysLater);

    const events = await settledEventsOf(restart.bureau, fireId);
    expect(events).toHaveLength(1);
    const record = await restart.bureau.tasks.record(fireId);
    expect(events[0]?.emittedAtMs).toBe(Date.parse(record?.settled?.at ?? ''));
    expect(events[0]?.emittedAtMs).toBeLessThan(twoDaysLater);
    await letGoOfTheDeadAppend(hold);
  });

  it('puts no bound on the pass when events are kept for ever', async () => {
    const path = harness.nextDatabasePath();
    const { fireId, hold } = await settleWithoutEvent(path);

    const restart = await openAt(path, 'restart', ORIGIN + 40 * DAY, {
      eventRetention: 'forever',
      taskRetention: 'forever',
    });

    expect(await settledEventsOf(restart.bureau, fireId)).toHaveLength(1);
    await letGoOfTheDeadAppend(hold);
  });
});
