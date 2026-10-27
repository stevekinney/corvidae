/**
 * COR-1704. `bureau.schedules` serves the `schedule` owner kind of the durable event history, so
 * the events a schedule's definition records stay readable once the flat `eventHistory` goes.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type DurableEventEnvelope } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import { finishes } from '../test/task-record-crash-agent.ts';
import type { Bureau } from '../types.ts';

const bureaus: Bureau<AgentDefinitions>[] = [];
const fixtures: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function open(durable: boolean): Promise<Bureau<AgentDefinitions>> {
  const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
  fixtures.push(fixture);
  const bureau = await createBureau<AgentDefinitions>({
    agents: { default: createAgent({ generate: finishes, toolbox: createToolbox([]) }) },
    storage: durable ? fixture.configuration : { type: 'memory' },
    durable,
    ...(durable ? { durableOwnership: { ownership: 'none' as const } } : {}),
  });
  bureaus.push(bureau);
  await bureau.recovery();
  return bureau;
}

const DEFINITION = { agentName: 'default', input: 'hourly digest', spec: '1h' } as const;

describe('bureau.schedules.events', () => {
  it('returns the schedule.created event recorded for a new schedule', async () => {
    const bureau = await open(true);
    const summary = await bureau.schedules.create(DEFINITION);

    const page = await bureau.schedules.events(summary!.id);

    if (!('events' in page)) throw new Error(`expected a page, got ${JSON.stringify(page)}`);
    expect(page.events.map((event) => event.kind)).toEqual(['schedule.created']);
  });

  it('reads the same history as eventHistory for the schedule owner, including a pause', async () => {
    const bureau = await open(true);
    const summary = await bureau.schedules.create(DEFINITION);
    await bureau.schedules.pause(summary!.id);

    const viaNamespace = await bureau.schedules.events(summary!.id);
    const viaOwner = await bureau.schedules.events(summary!.id);

    expect(viaNamespace).toEqual(viaOwner);
    if (!('events' in viaNamespace)) throw new Error('expected a page');
    expect(viaNamespace.events.map((event) => event.kind)).toEqual([
      'schedule.created',
      'schedule.paused',
    ]);
  });

  it('answers an unsupported capability on a Bureau with no persistent storage', async () => {
    const bureau = await open(false);

    expect(await bureau.schedules.events('schedule-1')).toEqual({
      outcome: 'unsupported-capability',
      reason: 'no-persistent-storage',
    });
    expect(bureau.schedules.subscribeEvents('schedule-1', () => {}).closed).toBe(true);
  });
});

describe('bureau.schedules.subscribeEvents', () => {
  it('replays the schedule.created event, then delivers a later pause live', async () => {
    const bureau = await open(true);
    const summary = await bureau.schedules.create(DEFINITION);
    const seen: DurableEventEnvelope[] = [];
    const bothSeen = Promise.withResolvers<void>();
    const subscription = bureau.schedules.subscribeEvents(summary!.id, (event) => {
      seen.push(event);
      if (seen.length === 2) bothSeen.resolve();
    });

    try {
      await bureau.schedules.pause(summary!.id);
      await bothSeen.promise;

      expect(seen.map((event) => event.kind)).toEqual(['schedule.created', 'schedule.paused']);
    } finally {
      subscription.unsubscribe();
    }
  });
});
