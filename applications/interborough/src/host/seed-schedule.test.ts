/**
 * The seeded schedule is remembered in Weft storage, under `app:interborough:seeded-schedule`, by
 * conditional writes (COR-1757). Each row crosses a starting state (what the record and the Bureau
 * already hold) and a failure (what `schedules.create` or the storage does mid-start) with its exit
 * (how many schedules the start created, what the record holds, whether the start rejected), and
 * then restarts once on the same storage to show what the next start does with what was left.
 */
import { createBureau, type Bureau } from '@lostgradient/bureau';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createSeededAgents,
  createSeededValidators,
  seedBureau,
  SEEDED_GOAL_RUN_IDENTIFIER,
  SEEDED_SCHEDULE_DESCRIPTION,
  SeededScheduleRecordLostError,
  type SeededAgents,
} from './seed.ts';

const RECORD_KEY = 'app:interborough:seeded-schedule';
const CREATE_FAILURE = new Error('The schedule store is unavailable.');
const STORAGE_FAILURE = new Error('The database is unavailable.');

type SeededBureau = Bureau<SeededAgents>;
type Create = SeededBureau['schedules']['create'];

const bureaus: SeededBureau[] = [];

afterEach(() => {
  for (const bureau of bureaus.splice(0)) bureau.dispose();
});

async function openBureau(storage: MemoryStorage): Promise<SeededBureau> {
  const bureau = await createBureau({
    agents: createSeededAgents('fixture-approval-secret'),
    validators: createSeededValidators(),
    storage,
    durable: true,
  });
  bureaus.push(bureau);
  return bureau;
}

async function readRecord(storage: MemoryStorage): Promise<string | undefined> {
  const bytes = await storage.get(RECORD_KEY);
  return bytes === null ? undefined : new TextDecoder().decode(bytes);
}

async function seededSchedules(bureau: SeededBureau) {
  const listing = await bureau.schedules.list();
  return (listing?.items ?? []).filter(
    (schedule) =>
      schedule.description === SEEDED_SCHEDULE_DESCRIPTION && schedule.status !== 'cancelled',
  );
}

/** A Bureau whose `schedules.create` is `create`, counted. Everything else is the real Bureau. */
function withCreate(bureau: SeededBureau, create: Create): SeededBureau {
  return { ...bureau, schedules: { ...bureau.schedules, create } };
}

/**
 * Fail the `call`-th (1-based) conditional write that touches the seeded-schedule record with
 * `STORAGE_FAILURE`. The Bureau writes conditionally to the same storage, so other keys are not counted.
 */
function failRecordWrite(storage: MemoryStorage, call: number): void {
  const real = storage.conditionalBatch.bind(storage);
  let received = 0;
  storage.conditionalBatch = async (conditions, operations) => {
    if (conditions.some((condition) => condition.key === RECORD_KEY)) {
      received += 1;
      if (received === call) throw STORAGE_FAILURE;
    }
    return real(conditions, operations);
  };
}

type Row = {
  name: string;
  /** What the record holds before the start; the Bureau holds nothing unless `existing` says so. */
  record?: string;
  existing?: 'seeded-schedule' | 'seeded-schedule-cancelled';
  /** What `schedules.create` does for the start: it delegates to the real one unless told. */
  create?: 'throws' | 'undefined';
  /** What happens to the record while `create` runs. */
  during?: 'overwritten' | 'deleted';
  /** The storage fails this conditional write (1 is the claim, 2 the release or the identifier). */
  failWrite?: number;
  starts?: number;
  first: {
    rejects?: Error | typeof SeededScheduleRecordLostError;
    created: number;
    seeded: number;
    /** `identifier` is the id of a seeded schedule this start created; `claim` is any `claimed:<uuid>`. */
    record: string;
  };
  /** A restart: a new Bureau on the same storage, with nothing failing. */
  restart: { created: number; seeded: number; record: string };
};

const rows: Row[] = [
  {
    name: 'first start: claims, creates once, and records the identifier',
    first: { created: 1, seeded: 1, record: 'identifier' },
    restart: { created: 0, seeded: 1, record: 'identifier' },
  },
  {
    name: 'overlapping starts: the one that loses the claim creates nothing',
    starts: 2,
    first: { created: 1, seeded: 1, record: 'identifier' },
    restart: { created: 0, seeded: 1, record: 'identifier' },
  },
  {
    name: 'five overlapping starts still create one',
    starts: 5,
    first: { created: 1, seeded: 1, record: 'identifier' },
    restart: { created: 0, seeded: 1, record: 'identifier' },
  },
  {
    name: 'record present, schedule absent: an operator deleted it, so it is not recreated',
    record: 'schedule-an-operator-deleted',
    first: { created: 0, seeded: 0, record: 'schedule-an-operator-deleted' },
    restart: { created: 0, seeded: 0, record: 'schedule-an-operator-deleted' },
  },
  {
    name: 'record present, schedule cancelled: delete-then-restart does not recreate it',
    record: 'recorded-below',
    existing: 'seeded-schedule-cancelled',
    first: { created: 0, seeded: 0, record: 'recorded-below' },
    restart: { created: 0, seeded: 0, record: 'recorded-below' },
  },
  {
    name: 'schedule present, record absent (an install from before the record): seeds one more once',
    existing: 'seeded-schedule',
    first: { created: 1, seeded: 2, record: 'identifier' },
    restart: { created: 0, seeded: 2, record: 'identifier' },
  },
  {
    name: 'a claim a crashed start left: nothing is created, nothing throws, the claim stays',
    record: 'claimed:crashed-before-the-identifier-was-written',
    first: {
      created: 0,
      seeded: 0,
      record: 'claimed:crashed-before-the-identifier-was-written',
    },
    restart: { created: 0, seeded: 0, record: 'claimed:crashed-before-the-identifier-was-written' },
  },
  {
    name: 'create throws: the error propagates, the claim is removed, the next start seeds',
    create: 'throws',
    first: { rejects: CREATE_FAILURE, created: 1, seeded: 0, record: 'absent' },
    restart: { created: 1, seeded: 1, record: 'identifier' },
  },
  {
    name: 'create returns undefined: no error, the claim is removed, the next start seeds',
    create: 'undefined',
    first: { created: 1, seeded: 0, record: 'absent' },
    restart: { created: 1, seeded: 1, record: 'identifier' },
  },
  {
    name: 'create throws after something else took the record: that value is not removed',
    create: 'throws',
    during: 'overwritten',
    first: { rejects: CREATE_FAILURE, created: 1, seeded: 0, record: 'someone-elses-value' },
    restart: { created: 0, seeded: 0, record: 'someone-elses-value' },
  },
  {
    name: 'create returns undefined after something else took the record: not removed either',
    create: 'undefined',
    during: 'overwritten',
    first: { created: 1, seeded: 0, record: 'someone-elses-value' },
    restart: { created: 0, seeded: 0, record: 'someone-elses-value' },
  },
  {
    name: 'create succeeds but the claim is gone: the start fails loudly and the record stays unset',
    during: 'deleted',
    first: { rejects: SeededScheduleRecordLostError, created: 1, seeded: 1, record: 'absent' },
    restart: { created: 1, seeded: 2, record: 'identifier' },
  },
  {
    name: 'create succeeds but another value replaced the claim: fails loudly, keeps that value',
    during: 'overwritten',
    first: {
      rejects: SeededScheduleRecordLostError,
      created: 1,
      seeded: 1,
      record: 'someone-elses-value',
    },
    restart: { created: 0, seeded: 1, record: 'someone-elses-value' },
  },
  {
    name: 'the claim write fails: create is never called and the record stays absent',
    failWrite: 1,
    first: { rejects: STORAGE_FAILURE, created: 0, seeded: 0, record: 'absent' },
    restart: { created: 1, seeded: 1, record: 'identifier' },
  },
  {
    name: 'create throws and removing the claim fails too: the create error wins, the claim stays',
    create: 'throws',
    failWrite: 2,
    first: { rejects: CREATE_FAILURE, created: 1, seeded: 0, record: 'claim' },
    restart: { created: 0, seeded: 0, record: 'claim' },
  },
  {
    name: 'crash between the schedule and the identifier: the install keeps its one schedule',
    failWrite: 2,
    first: { rejects: STORAGE_FAILURE, created: 1, seeded: 1, record: 'claim' },
    restart: { created: 0, seeded: 1, record: 'claim' },
  },
];

function matches(
  actual: string | undefined,
  expected: string,
  seeded: { id: string }[],
  excluded: string | undefined,
): boolean {
  if (expected === 'absent') return actual === undefined;
  if (expected === 'claim') return actual?.startsWith('claimed:') === true;
  if (expected === 'identifier') {
    return actual !== undefined && actual !== excluded && seeded.some(({ id }) => id === actual);
  }
  if (expected === 'recorded-below') return actual === excluded;
  return actual === expected;
}

describe('seedBureau records the seeded schedule in Weft storage', () => {
  for (const row of rows) {
    test(row.name, async () => {
      const storage = new MemoryStorage();
      const bureau = await openBureau(storage);
      let existingId: string | undefined;
      if (row.existing !== undefined) {
        const existing = await bureau.schedules.create({
          description: SEEDED_SCHEDULE_DESCRIPTION,
          agentName: 'assistant',
          input: 'Summarize what happened yesterday.',
          spec: '0 9 * * *',
        });
        existingId = existing?.id;
        if (row.existing === 'seeded-schedule-cancelled' && existingId !== undefined) {
          await bureau.schedules.cancel(existingId);
        }
      }
      const initialRecord = row.record === 'recorded-below' ? existingId : row.record;
      const encoder = new TextEncoder();
      if (initialRecord !== undefined) await storage.put(RECORD_KEY, encoder.encode(initialRecord));

      let created = 0;
      const create: Create = async (definition) => {
        created += 1;
        if (row.create === 'throws') {
          await interfere();
          throw CREATE_FAILURE;
        }
        const summary =
          row.create === 'undefined' ? undefined : await bureau.schedules.create(definition);
        await interfere();
        return summary;
      };
      async function interfere(): Promise<void> {
        if (row.during === 'overwritten') {
          await storage.put(RECORD_KEY, encoder.encode('someone-elses-value'));
        } else if (row.during === 'deleted') {
          await storage.delete(RECORD_KEY);
        }
      }
      if (row.failWrite !== undefined) failRecordWrite(storage, row.failWrite);

      const starts = Array.from({ length: row.starts ?? 1 }, () =>
        seedBureau(withCreate(bureau, create), storage),
      );
      const settled = await Promise.allSettled(starts);
      const rejections = settled.filter((result) => result.status === 'rejected');
      if (row.first.rejects === undefined) {
        expect(rejections).toEqual([]);
      } else {
        expect(rejections).toHaveLength(1);
        const reason = (rejections[0] as PromiseRejectedResult).reason;
        if (row.first.rejects instanceof Error) expect(reason).toBe(row.first.rejects);
        else expect(reason).toBeInstanceOf(row.first.rejects);
      }

      const afterFirst = await seededSchedules(bureau);
      expect(created).toBe(row.first.created);
      expect(afterFirst).toHaveLength(row.first.seeded);
      const recordAfterFirst = await readRecord(storage);
      expect(
        matches(recordAfterFirst, row.first.record, afterFirst, existingId),
        `the record is ${String(recordAfterFirst)}`,
      ).toBe(true);
      const goals = await bureau.goals.list();
      if (row.first.rejects === undefined) {
        expect(goals.map((goal) => goal.goalRunId)).toEqual([SEEDED_GOAL_RUN_IDENTIFIER]);
      }

      // Restart: a new Bureau on the same storage, and nothing fails this time.
      bureau.dispose();
      bureaus.splice(bureaus.indexOf(bureau), 1);
      storage.conditionalBatch = MemoryStorage.prototype.conditionalBatch.bind(storage);
      const restarted = await openBureau(storage);
      let createdAfterRestart = 0;
      await seedBureau(
        withCreate(restarted, async (definition) => {
          createdAfterRestart += 1;
          return restarted.schedules.create(definition);
        }),
        storage,
      );
      expect(createdAfterRestart).toBe(row.restart.created);
      const afterRestart = await seededSchedules(restarted);
      expect(afterRestart).toHaveLength(row.restart.seeded);
      const recordAfterRestart = await readRecord(storage);
      expect(
        matches(recordAfterRestart, row.restart.record, afterRestart, existingId),
        `the record is ${String(recordAfterRestart)}`,
      ).toBe(true);
    });
  }

  test('the record is the key "seeded-schedule" under the "app:interborough" scope', async () => {
    const storage = new MemoryStorage();
    const bureau = await openBureau(storage);
    await seedBureau(bureau, storage);
    const [schedule] = await seededSchedules(bureau);
    expect(await readRecord(storage)).toBe(schedule?.id);
    const keys: string[] = [];
    for await (const [key] of storage.scan('app:')) keys.push(key);
    expect(keys).toEqual([RECORD_KEY]);
  });
});
