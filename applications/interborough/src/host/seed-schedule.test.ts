/**
 * The seeded schedule is remembered in Weft storage, under `app:interborough:seeded-schedule`, by
 * conditional writes (COR-1757). Each row crosses a starting state (what the record and the Bureau
 * already hold) and a failure (what `schedules.create` or the storage does mid-start) with its exit
 * (how many schedules the start created, what the record holds, whether the start rejected), and
 * then restarts once on the same storage to show what the next start does with what was left.
 */
import { createBureau, ScheduleLocatorUnavailableError, type Bureau } from '@lostgradient/bureau';
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

async function seededGoals(bureau: SeededBureau): Promise<string[]> {
  const goals = await bureau.goals.list();
  return goals.map((goal) => goal.goalRunId);
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
  /**
   * What `schedules.create` does for the start: it delegates to the real one unless told.
   * `locator-unavailable` registers the schedule and then throws `ScheduleLocatorUnavailableError`.
   */
  create?: 'throws' | 'undefined' | 'locator-unavailable';
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
    /** Whether the seeded goal exists afterwards: only the start that won the claim creates it. */
    goal: boolean;
  };
  /** A restart: a new Bureau on the same storage, with nothing failing. */
  restart: { created: number; seeded: number; record: string; goal: boolean };
};

const CRASHED_CLAIM = 'claimed:crashed-before-the-identifier-was-written';

const rows: Row[] = [
  {
    name: 'first start: claims, creates once, records the identifier, and creates the goal',
    first: { created: 1, seeded: 1, record: 'identifier', goal: true },
    restart: { created: 0, seeded: 1, record: 'identifier', goal: true },
  },
  {
    name: 'overlapping starts: the one that loses the claim creates neither schedule nor goal',
    starts: 2,
    first: { created: 1, seeded: 1, record: 'identifier', goal: true },
    restart: { created: 0, seeded: 1, record: 'identifier', goal: true },
  },
  {
    name: 'five overlapping starts still create one',
    starts: 5,
    first: { created: 1, seeded: 1, record: 'identifier', goal: true },
    restart: { created: 0, seeded: 1, record: 'identifier', goal: true },
  },
  {
    name: 'record present, schedule absent: an operator deleted it, so it is not recreated and the goal is left alone',
    record: 'schedule-an-operator-deleted',
    first: { created: 0, seeded: 0, record: 'schedule-an-operator-deleted', goal: false },
    restart: { created: 0, seeded: 0, record: 'schedule-an-operator-deleted', goal: false },
  },
  {
    name: 'record present, schedule cancelled: delete-then-restart does not recreate it',
    record: 'recorded-below',
    existing: 'seeded-schedule-cancelled',
    first: { created: 0, seeded: 0, record: 'recorded-below', goal: false },
    restart: { created: 0, seeded: 0, record: 'recorded-below', goal: false },
  },
  {
    name: 'schedule present, record absent (an install from before the record): seeds one more once',
    existing: 'seeded-schedule',
    first: { created: 1, seeded: 2, record: 'identifier', goal: true },
    restart: { created: 0, seeded: 2, record: 'identifier', goal: true },
  },
  {
    name: 'a claim a crashed start left: nothing is created, nothing throws, the claim stays (and is reported)',
    record: CRASHED_CLAIM,
    first: { created: 0, seeded: 0, record: CRASHED_CLAIM, goal: false },
    restart: { created: 0, seeded: 0, record: CRASHED_CLAIM, goal: false },
  },
  {
    name: 'create throws: the error propagates, the claim is removed, no goal, the next start seeds',
    create: 'throws',
    first: { rejects: CREATE_FAILURE, created: 1, seeded: 0, record: 'absent', goal: false },
    restart: { created: 1, seeded: 1, record: 'identifier', goal: true },
  },
  {
    name: 'create returns undefined: no error, the claim is removed, the winner still creates the goal, the next start seeds',
    create: 'undefined',
    first: { created: 1, seeded: 0, record: 'absent', goal: true },
    restart: { created: 1, seeded: 1, record: 'identifier', goal: true },
  },
  {
    name: 'create throws ScheduleLocatorUnavailableError: the schedule is registered, so its identifier is recorded and seeding continues',
    create: 'locator-unavailable',
    first: { created: 1, seeded: 1, record: 'identifier', goal: true },
    restart: { created: 0, seeded: 1, record: 'identifier', goal: true },
  },
  {
    name: 'create throws ScheduleLocatorUnavailableError but the claim is gone: the start fails loudly, no goal',
    create: 'locator-unavailable',
    during: 'overwritten',
    first: {
      rejects: SeededScheduleRecordLostError,
      created: 1,
      seeded: 1,
      record: 'someone-elses-value',
      goal: false,
    },
    restart: { created: 0, seeded: 1, record: 'someone-elses-value', goal: false },
  },
  {
    name: 'create throws after something else took the record: that value is not removed',
    create: 'throws',
    during: 'overwritten',
    first: {
      rejects: CREATE_FAILURE,
      created: 1,
      seeded: 0,
      record: 'someone-elses-value',
      goal: false,
    },
    restart: { created: 0, seeded: 0, record: 'someone-elses-value', goal: false },
  },
  {
    name: 'create returns undefined after something else took the record: not removed either',
    create: 'undefined',
    during: 'overwritten',
    first: { created: 1, seeded: 0, record: 'someone-elses-value', goal: true },
    restart: { created: 0, seeded: 0, record: 'someone-elses-value', goal: true },
  },
  {
    name: 'create succeeds but the claim is gone: the start fails loudly and the record stays unset',
    during: 'deleted',
    first: {
      rejects: SeededScheduleRecordLostError,
      created: 1,
      seeded: 1,
      record: 'absent',
      goal: false,
    },
    restart: { created: 1, seeded: 2, record: 'identifier', goal: true },
  },
  {
    name: 'create succeeds but another value replaced the claim: fails loudly, keeps that value',
    during: 'overwritten',
    first: {
      rejects: SeededScheduleRecordLostError,
      created: 1,
      seeded: 1,
      record: 'someone-elses-value',
      goal: false,
    },
    restart: { created: 0, seeded: 1, record: 'someone-elses-value', goal: false },
  },
  {
    name: 'the claim write fails: create is never called and the record stays absent',
    failWrite: 1,
    first: { rejects: STORAGE_FAILURE, created: 0, seeded: 0, record: 'absent', goal: false },
    restart: { created: 1, seeded: 1, record: 'identifier', goal: true },
  },
  {
    name: 'create throws and removing the claim fails too: the create error wins, the claim stays',
    create: 'throws',
    failWrite: 2,
    first: { rejects: CREATE_FAILURE, created: 1, seeded: 0, record: 'claim', goal: false },
    restart: { created: 0, seeded: 0, record: 'claim', goal: false },
  },
  {
    name: 'crash between the schedule and the identifier: the install keeps its one schedule',
    failWrite: 2,
    first: { rejects: STORAGE_FAILURE, created: 1, seeded: 1, record: 'claim', goal: false },
    restart: { created: 0, seeded: 1, record: 'claim', goal: false },
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
        if (row.create === 'locator-unavailable' && summary !== undefined) {
          throw new ScheduleLocatorUnavailableError(summary.id);
        }
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

      const warnings: string[] = [];
      const starts = Array.from({ length: row.starts ?? 1 }, () =>
        seedBureau(withCreate(bureau, create), storage, (message) => warnings.push(message)),
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
      expect(await seededGoals(bureau)).toEqual(row.first.goal ? [SEEDED_GOAL_RUN_IDENTIFIER] : []);
      // An overlapping start may read the winner's claim while it is still working, which is reported
      // as a possibly stale claim, so only a lone start's warnings are exact.
      if ((row.starts ?? 1) === 1)
        expect(warnings).toHaveLength(initialRecord?.startsWith('claimed:') ? 1 : 0);

      // Restart: a new Bureau on the same storage, and nothing fails this time.
      bureau.dispose();
      bureaus.splice(bureaus.indexOf(bureau), 1);
      storage.conditionalBatch = MemoryStorage.prototype.conditionalBatch.bind(storage);
      const restarted = await openBureau(storage);
      let createdAfterRestart = 0;
      const restartWarnings: string[] = [];
      await seedBureau(
        withCreate(restarted, async (definition) => {
          createdAfterRestart += 1;
          return restarted.schedules.create(definition);
        }),
        storage,
        (message) => restartWarnings.push(message),
      );
      expect(restartWarnings).toHaveLength(recordAfterFirst?.startsWith('claimed:') ? 1 : 0);
      expect(await seededGoals(restarted)).toEqual(
        row.restart.goal ? [SEEDED_GOAL_RUN_IDENTIFIER] : [],
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

  test('a start that finds a claim left behind reports the record by key and does not call it a failure', async () => {
    const storage = new MemoryStorage();
    await storage.put(RECORD_KEY, new TextEncoder().encode(CRASHED_CLAIM));
    const bureau = await openBureau(storage);
    const warnings: string[] = [];
    await seedBureau(bureau, storage, (message) => warnings.push(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"seeded-schedule"');
    expect(warnings[0]).toContain('stale');
    expect(warnings[0]).toContain('no other host is starting');
    expect(warnings[0]).not.toContain(CRASHED_CLAIM);
  });

  test('a start that finds the recorded identifier says nothing', async () => {
    const storage = new MemoryStorage();
    const bureau = await openBureau(storage);
    await seedBureau(bureau, storage, () => {});
    const warnings: string[] = [];
    await seedBureau(bureau, storage, (message) => warnings.push(message));
    expect(warnings).toEqual([]);
  });
});
