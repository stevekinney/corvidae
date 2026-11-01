/**
 * COR-1978 — a scope over a real Bureau: the records `hook-scope.ts` reads are the ones the Bureau
 * keeps, and they are there when each event is dispatched.
 */
import { MemoryStorage } from '@lostgradient/storage';
import { quietFor } from '@lostgradient/testing/wait-until';
import type { EncryptionKey } from '@lostgradient/cryptography';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import {
  createReceiver,
  deliveriesOf,
  fireRunEvents,
  newEncryptionKey,
  openHooksBureau,
  type OpenedHooksBureau,
  waitForSettledDeliveries,
} from './hooks.test-support.ts';

let key: EncryptionKey;
beforeAll(async () => {
  key = await newEncryptionKey();
});

const opened: OpenedHooksBureau[] = [];
afterEach(async () => {
  for (const bureau of opened.splice(0)) await bureau.dispose();
});

async function open() {
  const bureau = await openHooksBureau({
    storage: new MemoryStorage(),
    fetch: createReceiver().fetch,
    key,
  });
  opened.push(bureau);
  return bureau.bureau;
}

const notify = { action: { type: 'notify' } } as const;

describe('a scope over a real Bureau', () => {
  it('reads a task’s agent: a hook on its agent fires, a hook on another does not', async () => {
    const bureau = await open();
    const hooks = bureau.hooks!;
    const events = ['run.registered', 'run.settled'];
    const mine = await hooks.create({ ...notify, events, scope: { kind: 'agent', id: 'default' } });
    const other = await hooks.create({ ...notify, events, scope: { kind: 'agent', id: 'other' } });
    const unscoped = await hooks.create({ ...notify, events });

    await fireRunEvents(bureau);
    await waitForSettledDeliveries(bureau, unscoped.id, 2);
    await waitForSettledDeliveries(bureau, mine.id, 2);
    await quietFor(50);

    expect(await deliveriesOf(bureau, other.id)).toEqual([]);
    const delivered = await deliveriesOf(bureau, mine.id);
    expect(delivered.map((delivery) => delivery.kind).toSorted()).toEqual([
      'run.registered',
      'run.settled',
    ]);
  });

  it('reads an agent schedule’s agent from its stored input, and its id from the event', async () => {
    const bureau = await open();
    const hooks = bureau.hooks!;
    const created = (await bureau.schedules.create({
      agentName: 'default',
      input: 'x',
      spec: '1h',
    }))!;
    const events = ['schedule.paused'];
    const agent = await hooks.create({
      ...notify,
      events,
      scope: { kind: 'agent', id: 'default' },
    });
    const schedule = await hooks.create({
      ...notify,
      events,
      scope: { kind: 'schedule', id: created.id },
    });
    const other = await hooks.create({
      ...notify,
      events,
      scope: { kind: 'schedule', id: 'another-schedule' },
    });

    await bureau.schedules.pause(created.id);
    await waitForSettledDeliveries(bureau, agent.id, 1);
    await waitForSettledDeliveries(bureau, schedule.id, 1);
    await quietFor(50);

    expect(await deliveriesOf(bureau, other.id)).toEqual([]);
  });
});
