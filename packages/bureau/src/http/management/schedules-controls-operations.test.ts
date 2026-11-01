/**
 * COR-1829 — `bureau.schedules.skipnext`, `bureau.schedules.runnow`, and `bureau.schedules.missed`
 * over a real Bureau and its handler: what each does to a schedule, who may call it, and the
 * origin of the task a run-now starts. Schedules here are hourly and nothing waits for them.
 */
import { createAgent } from '@lostgradient/operative';
import { encode, KEYS } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';
import {
  bureauSchedulesOperations,
  schedulesMissedOperation,
  schedulesRunNowOperation,
  schedulesSkipNextOperation,
} from './schedules-operations.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const writer = createAgent({ name: 'writer', generate: parkingUntilAborted });

async function serve(storage = new MemoryStorage()): Promise<OpenedBureau> {
  const opened = await openBureau({
    agents: { writer },
    a2aAgents: ['writer'],
    generate: parkingUntilAborted,
    storage,
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

const NEW_SCHEDULE = { agentName: 'writer', spec: '1h', input: 'tick' };

async function createdBy(opened: OpenedBureau, key: string, extra: object = {}): Promise<string> {
  const body = await rpc(
    opened.handler,
    'bureau.schedules.create',
    { ...NEW_SCHEDULE, ...extra },
    key,
  );
  expect(body.error).toBeUndefined();
  return body.result!['id'] as string;
}

const status = (body: RpcBody) => body.error?.data?.httpStatus;

async function viewOf(opened: OpenedBureau, id: string, key = 'alice-key') {
  const body = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, key);
  expect(body.error).toBeUndefined();
  return body.result!;
}

describe('the operations list', () => {
  it('serves skipnext, runnow, and missed beside the others, registered and in OpenRPC', async () => {
    const names = bureauSchedulesOperations.map((operation) => operation.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'bureau.schedules.skipnext',
        'bureau.schedules.runnow',
        'bureau.schedules.missed',
      ]),
    );
    expect(schedulesSkipNextOperation.name).toBe('bureau.schedules.skipnext');
    expect(schedulesRunNowOperation.name).toBe('bureau.schedules.runnow');
    expect(schedulesMissedOperation.name).toBe('bureau.schedules.missed');
  });
});

describe('bureau.schedules.skipnext', () => {
  it('skips the next fire once: the view names it, the revision stays, and a repeat changes nothing', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const before = await viewOf(opened, id);
    expect(before['skipUntil']).toBeNull();

    const skipped = await rpc(
      opened.handler,
      'bureau.schedules.skipnext',
      { scheduleId: id },
      'alice-key',
    );
    expect(skipped.result).toEqual({ id, status: 'active', revision: 1 });
    const after = await viewOf(opened, id);
    expect(after['skipUntil']).toBe(after['nextFireAt']);
    expect(after['revision']).toBe(1);

    const again = await rpc(
      opened.handler,
      'bureau.schedules.skipnext',
      { scheduleId: id },
      'alice-key',
    );
    expect(again.result).toEqual({ id, status: 'active', revision: 1 });
  });

  it('answers a stale expectedRevision with StaleRevision and writes nothing', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');

    const stale = await rpc(
      opened.handler,
      'bureau.schedules.skipnext',
      { scheduleId: id, expectedRevision: 9 },
      'alice-key',
    );

    expect(status(stale)).toBe(409);
    expect(stale.error?.data).toMatchObject({ currentRevision: 1, expectedRevision: 9 });
    const unchanged = await viewOf(opened, id);
    expect(unchanged['skipUntil']).toBeNull();
  });

  it('skips the occurrence it names, and a repeat naming the same one changes nothing', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const seen = await viewOf(opened, id);
    const occurrence = seen['nextFireAt'] as string;

    const skipped = await rpc(
      opened.handler,
      'bureau.schedules.skipnext',
      { scheduleId: id, occurrence },
      'alice-key',
    );
    expect(skipped.result).toEqual({ id, status: 'active', revision: 1 });
    const after = await viewOf(opened, id);
    expect(after['skipUntil']).toBe(occurrence);

    const again = await rpc(
      opened.handler,
      'bureau.schedules.skipnext',
      { scheduleId: id, occurrence },
      'alice-key',
    );
    expect(again.result).toEqual({ id, status: 'active', revision: 1 });
  });

  it('refuses an occurrence that is not the next run as Conflict occurrence-not-next, and writes nothing', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const seen = await viewOf(opened, id);
    const next = Date.parse(seen['nextFireAt'] as string);

    for (const moved of [next - 1, next + 3_600_000]) {
      const refused = await rpc(
        opened.handler,
        'bureau.schedules.skipnext',
        { scheduleId: id, occurrence: new Date(moved).toISOString() },
        'alice-key',
      );
      expect([moved, status(refused)]).toEqual([moved, 409]);
      expect(refused.error?.data?.['reason']).toBe('occurrence-not-next');
    }
    const unchanged = await viewOf(opened, id);
    expect(unchanged['skipUntil']).toBeNull();
  });

  it('checks the revision before the occurrence', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const seen = await viewOf(opened, id);

    const stale = await rpc(
      opened.handler,
      'bureau.schedules.skipnext',
      { scheduleId: id, expectedRevision: 9, occurrence: seen['nextFireAt'] },
      'alice-key',
    );

    expect(status(stale)).toBe(409);
    expect(stale.error?.data).toMatchObject({ currentRevision: 1, expectedRevision: 9 });
  });

  it('answers an occurrence that is not an ISO 8601 instant, or is before 1970, as InvalidParams', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');

    for (const occurrence of ['soon', '1700000000000', '1969-12-31T23:59:59.000Z', 7]) {
      const refused = await rpc(
        opened.handler,
        'bureau.schedules.skipnext',
        { scheduleId: id, occurrence },
        'alice-key',
      );
      expect([occurrence, status(refused)]).toEqual([occurrence, 400]);
    }
    const unchanged = await viewOf(opened, id);
    expect(unchanged['skipUntil']).toBeNull();
  });

  it('answers a paused or cancelled schedule as a Conflict, and ends a skip when the schedule is paused', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    await rpc(opened.handler, 'bureau.schedules.skipnext', { scheduleId: id }, 'alice-key');
    await rpc(opened.handler, 'bureau.schedules.pause', { scheduleId: id }, 'alice-key');
    const ended = await viewOf(opened, id);
    expect(ended['skipUntil']).toBeNull();

    const paused = await rpc(
      opened.handler,
      'bureau.schedules.skipnext',
      { scheduleId: id },
      'alice-key',
    );
    expect(status(paused)).toBe(409);
    expect(paused.error?.data?.['reason']).toBe('schedule-not-active');
  });

  it('lets another principal skip only with bureau.schedules:write, and answers anyone else as a missing schedule', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');

    for (const key of ['bob-key', 'schedules-reader-key']) {
      const denied = await rpc(
        opened.handler,
        'bureau.schedules.skipnext',
        { scheduleId: id },
        key,
      );
      expect([key, status(denied)]).toEqual([key, 404]);
    }
    const untouched = await viewOf(opened, id);
    expect(untouched['skipUntil']).toBeNull();
    const allowed = await rpc(
      opened.handler,
      'bureau.schedules.skipnext',
      { scheduleId: id },
      'schedules-writer-key',
    );
    expect(allowed.result).toMatchObject({ revision: 1 });
    const skipped = await viewOf(opened, id);
    expect(skipped['skipUntil']).not.toBeNull();
  });
});

describe('bureau.schedules.runnow', () => {
  it('starts a task whose origin is a manual schedule fire, and leaves the cadence alone', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key', { overlap: 'allow' });
    const before = await viewOf(opened, id);

    const started = await rpc(
      opened.handler,
      'bureau.schedules.runnow',
      { scheduleId: id },
      'alice-key',
    );

    expect(started.result).toMatchObject({ outcome: 'started' });
    const taskId = started.result!['taskId'] as string;
    const record = await opened.bureau.internals.taskRegistry.record(taskId);
    expect(record).toMatchObject({ owner: OWNER.alice, agentName: 'writer' });
    expect(record?.origin).toEqual({
      kind: 'schedule',
      scheduleId: id,
      fireId: taskId,
      manual: true,
    });
    const after = await viewOf(opened, id);
    expect(after['nextFireAt']).toBe(before['nextFireAt']);
    expect(after['lastFireAt']).toBeNull();
    expect(after['revision']).toBe(before['revision']);

    const byOrigin = await rpc(
      opened.handler,
      'bureau.tasks.list',
      { origin: 'schedule' },
      'alice-key',
    );
    expect((byOrigin.result!['tasks'] as Array<{ id: string }>).map((task) => task.id)).toContain(
      taskId,
    );
  });

  it('reports skipped, naming the running task, while a run is going under the skip policy', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const first = await rpc(
      opened.handler,
      'bureau.schedules.runnow',
      { scheduleId: id },
      'alice-key',
    );
    expect(first.result).toMatchObject({ outcome: 'started' });

    const second = await rpc(
      opened.handler,
      'bureau.schedules.runnow',
      { scheduleId: id },
      'alice-key',
    );

    expect(second.result).toEqual({
      outcome: 'skipped',
      blockingTaskId: first.result!['taskId'],
    });
    const counted = await viewOf(opened, id);
    expect(counted['skippedCount']).toBe(1);
  });

  it('runs a paused schedule, answers a cancelled one as a Conflict, and a missing one as NotFound', async () => {
    const opened = await serve();
    const paused = await createdBy(opened, 'alice-key');
    await rpc(opened.handler, 'bureau.schedules.pause', { scheduleId: paused }, 'alice-key');
    const cancelled = await createdBy(opened, 'alice-key');
    await rpc(opened.handler, 'bureau.schedules.cancel', { scheduleId: cancelled }, 'alice-key');

    const ran = await rpc(
      opened.handler,
      'bureau.schedules.runnow',
      { scheduleId: paused },
      'alice-key',
    );
    expect(ran.result).toMatchObject({ outcome: 'started' });
    const refused = await rpc(
      opened.handler,
      'bureau.schedules.runnow',
      { scheduleId: cancelled },
      'alice-key',
    );
    expect(status(refused)).toBe(409);
    const missing = await rpc(
      opened.handler,
      'bureau.schedules.runnow',
      { scheduleId: 'nope' },
      'alice-key',
    );
    expect(status(missing)).toBe(404);
  });

  it('lets another principal run a schedule only with bureau.schedules:write', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');

    for (const key of ['bob-key', 'schedules-reader-key']) {
      const denied = await rpc(opened.handler, 'bureau.schedules.runnow', { scheduleId: id }, key);
      expect([key, status(denied)]).toEqual([key, 404]);
    }
    const allowed = await rpc(
      opened.handler,
      'bureau.schedules.runnow',
      { scheduleId: id },
      'schedules-writer-key',
    );
    expect(allowed.result).toMatchObject({ outcome: 'started' });
    // The run belongs to the schedule's owner, not to the operator who started it.
    const record = await opened.bureau.internals.taskRegistry.record(
      allowed.result!['taskId'] as string,
    );
    expect(record?.owner).toBe(OWNER.alice);
  });
});

describe('bureau.schedules.missed', () => {
  /** Stores the missed-fire row Weft's engine writes, as a restart would find it. */
  async function storeMissed(
    storage: MemoryStorage,
    scheduleId: string,
    occurrence: number,
    reason: 'late' | 'dst-gap',
  ): Promise<void> {
    await storage.put(
      KEYS.scheduleMissed(scheduleId, occurrence, reason),
      encode({ scheduleId, occurrence, reason, count: 1, recordedAt: occurrence + 5 }),
    );
  }

  it('lists the rows newest first with the schedule’s owner, and honors limit', async () => {
    const storage = new MemoryStorage();
    const opened = await serve(storage);
    const id = await createdBy(opened, 'alice-key');
    const empty = await rpc(
      opened.handler,
      'bureau.schedules.missed',
      { scheduleId: id },
      'alice-key',
    );
    expect(empty.result).toEqual({ missed: [] });
    await storeMissed(storage, id, Date.parse('2026-03-08T10:00:00.000Z'), 'dst-gap');
    await storeMissed(storage, id, Date.parse('2026-03-09T09:30:00.000Z'), 'late');

    const listed = await rpc(
      opened.handler,
      'bureau.schedules.missed',
      { scheduleId: id },
      'alice-key',
    );
    expect(listed.result).toEqual({
      missed: [
        {
          scheduleId: id,
          owner: OWNER.alice,
          occurrence: '2026-03-09T09:30:00.000Z',
          reason: 'late',
          count: 1,
          recordedAt: '2026-03-09T09:30:00.005Z',
        },
        {
          scheduleId: id,
          owner: OWNER.alice,
          occurrence: '2026-03-08T10:00:00.000Z',
          reason: 'dst-gap',
          count: 1,
          recordedAt: '2026-03-08T10:00:00.005Z',
        },
      ],
    });
    const limited = await rpc(
      opened.handler,
      'bureau.schedules.missed',
      { scheduleId: id, limit: 1 },
      'alice-key',
    );
    expect((limited.result!['missed'] as unknown[]).length).toBe(1);
  });

  it('shows rows only to the owner and to bureau.schedules:read, and refuses a limit past what is kept', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');

    for (const key of ['bob-key', 'schedules-writer-key']) {
      const denied = await rpc(opened.handler, 'bureau.schedules.missed', { scheduleId: id }, key);
      expect([key, status(denied)]).toEqual([key, 404]);
    }
    for (const key of ['schedules-reader-key', 'operator-key']) {
      const read = await rpc(opened.handler, 'bureau.schedules.missed', { scheduleId: id }, key);
      expect(read.result).toEqual({ missed: [] });
    }
    const tooMany = await rpc(
      opened.handler,
      'bureau.schedules.missed',
      { scheduleId: id, limit: 101 },
      'alice-key',
    );
    expect(status(tooMany)).toBe(400);
    const missing = await rpc(
      opened.handler,
      'bureau.schedules.missed',
      { scheduleId: 'nope' },
      'alice-key',
    );
    expect(status(missing)).toBe(404);
  });
});
