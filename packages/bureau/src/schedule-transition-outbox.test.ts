/**
 * COR-194 — a schedule pause, resume, or cancel commits its pending durable record in the same
 * write as the schedule's new state, so a process that dies before recording it leaves the fact
 * for the next boot, which records it exactly once.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  type DurableEventEnvelope,
  SchedulePausedEvent,
} from '@lostgradient/operative';
import { encode, Engine, resolveStorage, type ScheduleTransitionOptions } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import {
  decodeScheduleTransition,
  SCHEDULE_TRANSITION_KEY_PREFIX,
  scheduleTransitionKey,
  type ScheduleTransitionKind,
  scheduleTransitionOperation,
} from './schedule-transition-outbox';
import { finishes } from './test/task-record-crash-agent';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import type { Bureau } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const fixtures: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function newFixture() {
  const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
  fixtures.push(fixture);
  return fixture;
}

async function open(fixture: ReturnType<typeof newFixture>): Promise<Bureau<AgentDefinitions>> {
  const generate = finishes;
  const bureau = await createBureau<AgentDefinitions>({
    agents: { researcher: createAgent({ generate, toolbox: createToolbox([]) }) },
    generate,
    toolbox: createToolbox([]),
    storage: fixture.configuration,
    durableExecution: true,
    durableOwnership: { ownership: 'none' },
  });
  bureaus.push(bureau);
  await bureau.waitForRecovery?.();
  return bureau;
}

async function close(bureau: Bureau<AgentDefinitions>): Promise<void> {
  bureaus.splice(bureaus.indexOf(bureau), 1);
  await bureau.dispose();
}

async function createSchedule(bureau: Bureau<AgentDefinitions>): Promise<string> {
  const summary = await bureau.createSchedule({
    agentName: 'researcher',
    input: 'hourly digest',
    spec: '1h',
  });
  if (summary === undefined) throw new Error('expected a durable schedule');
  return summary.id;
}

async function scheduleHistory(
  bureau: Bureau<AgentDefinitions>,
  scheduleId: string,
): Promise<readonly DurableEventEnvelope[]> {
  const page = await bureau.eventHistory({ kind: 'schedule', id: scheduleId });
  if (!('events' in page)) throw new Error(`expected a page, got ${JSON.stringify(page)}`);
  return page.events;
}

async function transitionKinds(
  bureau: Bureau<AgentDefinitions>,
  scheduleId: string,
): Promise<string[]> {
  const events = await scheduleHistory(bureau, scheduleId);
  return events.map((event) => event.kind).filter((kind) => kind !== 'schedule.created');
}

async function auditTypes(bureau: Bureau<AgentDefinitions>, scheduleId: string): Promise<string[]> {
  const records = await bureau.auditTrail!.query({ runId: `schedule:${scheduleId}` });
  return records.map((record) => record.type).filter((type) => type !== 'schedule.created');
}

/** Commits `kind` with its pending record from an engine no Bureau drains, as a process that died after the commit. */
async function commitWithoutRecording(
  fixture: ReturnType<typeof newFixture>,
  kind: ScheduleTransitionKind,
  scheduleId: string,
): Promise<string> {
  const storage = await resolveStorage(fixture.configuration);
  try {
    const engine = new Engine({ storage, backgroundTasks: 'manual' });
    try {
      const transition = { kind, scheduleId, committedAtMs: Date.now() };
      const key = scheduleTransitionKey(transition, 'crashed-ordinal');
      const options: ScheduleTransitionOptions = {
        additionalOperations: [scheduleTransitionOperation(key, transition)],
      };
      if (kind === 'schedule.paused') await engine.pauseSchedule(scheduleId, options);
      else if (kind === 'schedule.resumed') await engine.resumeSchedule(scheduleId, options);
      else await engine.cancelSchedule(scheduleId, options);
      expect(await storage.get(key)).not.toBeNull();
      return key;
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  } finally {
    storage[Symbol.dispose]();
  }
}

async function pendingKeys(fixture: ReturnType<typeof newFixture>): Promise<string[]> {
  const storage = await resolveStorage(fixture.configuration);
  try {
    const keys: string[] = [];
    for await (const [key] of storage.scan(SCHEDULE_TRANSITION_KEY_PREFIX)) keys.push(key);
    return keys;
  } finally {
    storage[Symbol.dispose]();
  }
}

describe('schedule transitions through the outbox (COR-194)', () => {
  it('records a pause, resume, and cancel once each in durable history and the audit trail, and leaves nothing pending', async () => {
    const fixture = newFixture();
    const bureau = await open(fixture);
    const scheduleId = await createSchedule(bureau);

    await bureau.pauseSchedule(scheduleId);
    await bureau.resumeSchedule(scheduleId);
    await bureau.cancelSchedule(scheduleId);

    const expected = ['schedule.paused', 'schedule.resumed', 'schedule.cancelled'];
    expect(await transitionKinds(bureau, scheduleId)).toEqual(expected);
    expect(await auditTypes(bureau, scheduleId)).toEqual(expected);
    await close(bureau);
    expect(await pendingKeys(fixture)).toEqual([]);
  });

  it('records and dispatches nothing for a pause or resume Weft finds nothing to do for, and records each cancel', async () => {
    const fixture = newFixture();
    const bureau = await open(fixture);
    const scheduleId = await createSchedule(bureau);
    const paused: SchedulePausedEvent[] = [];
    bureau.addEventListener(SchedulePausedEvent.type, (event) => paused.push(event));

    await bureau.resumeSchedule(scheduleId);
    await bureau.pauseSchedule(scheduleId);
    expect(await bureau.pauseSchedule(scheduleId)).toBe(true);
    await bureau.cancelSchedule(scheduleId);
    await bureau.cancelSchedule(scheduleId);

    expect(paused).toHaveLength(1);
    expect(paused[0]!.dedupeKey).toStartWith(SCHEDULE_TRANSITION_KEY_PREFIX);
    expect(await transitionKinds(bureau, scheduleId)).toEqual([
      'schedule.paused',
      'schedule.cancelled',
      'schedule.cancelled',
    ]);
  });

  for (const kind of ['schedule.paused', 'schedule.resumed', 'schedule.cancelled'] as const) {
    it(`records a ${kind} committed by a process that died before recording it exactly once at the next boot`, async () => {
      const fixture = newFixture();
      const first = await open(fixture);
      const scheduleId = await createSchedule(first);
      if (kind === 'schedule.resumed') await first.pauseSchedule(scheduleId);
      const before = await transitionKinds(first, scheduleId);
      await close(first);

      const key = await commitWithoutRecording(fixture, kind, scheduleId);

      const restarted = await open(fixture);
      expect(await transitionKinds(restarted, scheduleId)).toEqual([...before, kind]);
      expect(await auditTypes(restarted, scheduleId)).toEqual([...before, kind]);
      await close(restarted);
      expect(await pendingKeys(fixture)).not.toContain(key);

      // A later boot finds nothing pending and records nothing twice.
      const again = await open(fixture);
      expect(await transitionKinds(again, scheduleId)).toEqual([...before, kind]);
      expect(await auditTypes(again, scheduleId)).toEqual([...before, kind]);
    });
  }

  it('reads back only a pending record this build wrote', () => {
    const transition = { kind: 'schedule.paused', scheduleId: 'a:b', committedAtMs: 7 } as const;
    const key = scheduleTransitionKey(transition, 'ordinal');
    const operation = scheduleTransitionOperation(key, transition);
    if (operation.type !== 'put') throw new Error('expected a put');

    expect(key).toBe(`${SCHEDULE_TRANSITION_KEY_PREFIX}a%3Ab:0000000000000007:ordinal`);
    expect(decodeScheduleTransition(operation.value)).toEqual(transition);
    expect(decodeScheduleTransition(new Uint8Array([0xff, 0x00]))).toBeUndefined();
    expect(decodeScheduleTransition(encode('schedule.paused'))).toBeUndefined();
    expect(
      decodeScheduleTransition(
        encode({ ...transition, schemaVersion: 1, kind: 'schedule.created' }),
      ),
    ).toBeUndefined();
  });

  it('keeps a pending record it cannot read at boot, and boots', async () => {
    const fixture = newFixture();
    await close(await open(fixture));
    const key = `${SCHEDULE_TRANSITION_KEY_PREFIX}unreadable`;
    const storage = await resolveStorage(fixture.configuration);
    try {
      await storage.put(key, encode({ schemaVersion: 2 }));
    } finally {
      storage[Symbol.dispose]();
    }

    await close(await open(fixture));

    expect(await pendingKeys(fixture)).toEqual([key]);
  });

  it("defers a schedule's later transitions behind one it cannot record, and records other schedules'", async () => {
    const fixture = newFixture();
    const first = await open(fixture);
    const blocked = await createSchedule(first);
    const other = await createSchedule(first);
    await close(first);
    const unreadable = `${SCHEDULE_TRANSITION_KEY_PREFIX}${encodeURIComponent(blocked)}:0000000000000001:first`;
    const later = { kind: 'schedule.paused', scheduleId: blocked, committedAtMs: 2 } as const;
    const laterKey = scheduleTransitionKey(later, 'second');
    const storage = await resolveStorage(fixture.configuration);
    try {
      await storage.put(unreadable, encode({ schemaVersion: 2 }));
      const operation = scheduleTransitionOperation(laterKey, later);
      if (operation.type !== 'put') throw new Error('expected a put');
      await storage.put(laterKey, operation.value);
    } finally {
      storage[Symbol.dispose]();
    }
    const otherKey = await commitWithoutRecording(fixture, 'schedule.paused', other);

    const restarted = await open(fixture);

    expect(await transitionKinds(restarted, blocked)).toEqual([]);
    expect(await transitionKinds(restarted, other)).toEqual(['schedule.paused']);
    await close(restarted);
    const left = await pendingKeys(fixture);
    expect(left).toContain(unreadable);
    expect(left).toContain(laterKey);
    expect(left).not.toContain(otherKey);
  });

  it('records a transition left pending in a running process at the next durable maintenance pass', async () => {
    const fixture = newFixture();
    const bureau = await open(fixture);
    const scheduleId = await createSchedule(bureau);

    const key = await commitWithoutRecording(fixture, 'schedule.paused', scheduleId);
    expect(await transitionKinds(bureau, scheduleId)).toEqual([]);
    await bureau.runDurableMaintenance();

    expect(await transitionKinds(bureau, scheduleId)).toEqual(['schedule.paused']);
    expect(await auditTypes(bureau, scheduleId)).toEqual(['schedule.paused']);
    await close(bureau);
    expect(await pendingKeys(fixture)).not.toContain(key);
  });

  it("records a live transition behind its schedule's earlier pending one, in commit order", async () => {
    const fixture = newFixture();
    const bureau = await open(fixture);
    const scheduleId = await createSchedule(bureau);
    const resumed: string[] = [];
    bureau.addEventListener('schedule.resumed', (event) => resumed.push(event.scheduleId));
    await commitWithoutRecording(fixture, 'schedule.paused', scheduleId);

    await bureau.resumeSchedule(scheduleId);

    expect(await transitionKinds(bureau, scheduleId)).toEqual([
      'schedule.paused',
      'schedule.resumed',
    ]);
    expect(resumed).toEqual([scheduleId]);
    await close(bureau);
    expect(await pendingKeys(fixture)).toEqual([]);
  });
});
