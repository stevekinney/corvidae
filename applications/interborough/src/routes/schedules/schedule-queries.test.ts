/**
 * Unit tests for `schedule-queries.ts`'s plain fetch/mutation helpers. Each
 * function's parameter is narrowed to the one `HttpClient` method it needs
 * (matching `src/lib/scopes.svelte.ts`'s `PrincipalProbeClient` precedent),
 * so these tests pass a minimal structural fake rather than constructing a
 * real `HttpClient` or reaching for an `as HttpClient` cast.
 */
import { rejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import { HttpClientError, type ScheduleSummary } from '@lostgradient/weft';

import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';

import {
  cancelSchedule,
  createSchedule,
  fetchScheduleDetail,
  fetchScheduleList,
  fetchScheduleRunHistory,
  listScheduleMissed,
  pauseSchedule,
  resumeSchedule,
  runNowSchedule,
  scheduleDetailQueryKey,
  scheduleMissedQueryKey,
  scheduleRunHistoryQueryKey,
  skipNextSchedule,
  updateScheduleSpec,
  type ScheduleControlClient,
} from './schedule-queries.ts';

const SUMMARY: ScheduleSummary = {
  id: 'nightly-rollup',
  workflowType: 'report-gen',
  cronExpression: '0 2 * * *',
  timeZone: 'UTC',
  status: 'active',
  overlap: 'skip',
  backfill: false,
  revisionPolicy: 'active-at-fire',
  createdAt: 0,
  updatedAt: 0,
  missedFireCount: 0,
  // Required since COR-1224 gave schedules durable skip accounting. The decoder treats an absent
  // value as zero, so only in-repo literals like this one need it.
  skippedCount: 0,
  revision: 1,
  nextFireAt: 1000,
  queuedRuns: [],
};

describe('scheduleDetailQueryKey', () => {
  test('matches the shared tuple shape used by other domain detail keys', () => {
    expect(scheduleDetailQueryKey('nightly-rollup')).toEqual([
      'schedules',
      'detail',
      'nightly-rollup',
    ]);
  });
});

describe('scheduleRunHistoryQueryKey', () => {
  test('is a distinct tuple from the detail key for the same id', () => {
    expect(scheduleRunHistoryQueryKey('nightly-rollup')).toEqual([
      'schedules',
      'run-history',
      'nightly-rollup',
    ]);
    expect(scheduleRunHistoryQueryKey('nightly-rollup')).not.toEqual(
      scheduleDetailQueryKey('nightly-rollup'),
    );
  });
});

describe('fetchScheduleRunHistory', () => {
  test('delegates to client.list with the scheduleId filter and a bounded limit', async () => {
    let receivedFilter: unknown;
    const client = {
      list: async (filter: unknown) => {
        receivedFilter = filter;
        return { items: [], total: 0, offset: 0, limit: 10 };
      },
    };

    await fetchScheduleRunHistory(client, 'nightly-rollup');

    expect(receivedFilter).toEqual({ scheduleId: 'nightly-rollup', limit: 10 });
  });
});

describe('fetchScheduleList', () => {
  test('delegates to client.listSchedules with the given filter', async () => {
    let receivedFilter: unknown;
    const client = {
      listSchedules: async (filter: unknown) => {
        receivedFilter = filter;
        return { items: [SUMMARY], total: 1, offset: 0, limit: 50 };
      },
    };

    const result = await fetchScheduleList(client, { status: 'active' });

    expect(receivedFilter).toEqual({ status: 'active' });
    expect(result.items).toEqual([SUMMARY]);
  });
});

describe('fetchScheduleDetail', () => {
  test('delegates to client.getSchedule and passes through null', async () => {
    const found = { getSchedule: async () => SUMMARY };
    expect(await fetchScheduleDetail(found, 'nightly-rollup')).toBe(SUMMARY);

    const missing = { getSchedule: async () => null };
    expect(await fetchScheduleDetail(missing, 'missing')).toBeNull();
  });
});

describe('createSchedule', () => {
  test('passes workflowType/input/spec through and omits undefined optional fields', async () => {
    let received: readonly unknown[] = [];
    const client = {
      schedule: async (...args: unknown[]) => {
        received = args;
        return { id: 'nightly-rollup' };
      },
    };

    const result = await createSchedule(client, {
      workflowType: 'report-gen',
      input: { day: 'today' },
      spec: { cron: '0 9 * * *' },
    });

    expect(result).toEqual({ id: 'nightly-rollup' });
    expect(received[0]).toBe('report-gen');
    expect(received[1]).toEqual({ day: 'today' });
    expect(received[2]).toEqual({ cron: '0 9 * * *' });
    expect(received[3]).toEqual({});
  });

  test('forwards every optional field when supplied', async () => {
    let receivedOptions: unknown;
    const client = {
      schedule: async (..._args: unknown[]) => {
        receivedOptions = _args[3];
        return { id: 'custom-id' };
      },
    };

    await createSchedule(client, {
      workflowType: 'report-gen',
      input: null,
      spec: { cron: '0 9 * * *' },
      id: 'custom-id',
      description: 'Nightly report',
      overlap: 'queue',
      backfill: true,
      jitter: '30s',
      revisionPolicy: 'pinned',
    });

    expect(receivedOptions).toEqual({
      id: 'custom-id',
      description: 'Nightly report',
      overlap: 'queue',
      backfill: true,
      jitter: '30s',
      revisionPolicy: 'pinned',
    });
  });

  test('omits revisionPolicy when not supplied', async () => {
    let receivedOptions: unknown;
    const client = {
      schedule: async (..._args: unknown[]) => {
        receivedOptions = _args[3];
        return { id: 'custom-id' };
      },
    };

    await createSchedule(client, {
      workflowType: 'report-gen',
      input: null,
      spec: { cron: '0 9 * * *' },
    });

    expect(receivedOptions).toEqual({});
  });
});

describe('updateScheduleSpec / pauseSchedule / resumeSchedule / cancelSchedule', () => {
  test('each delegates to the matching client method with the schedule id', async () => {
    const calls: string[] = [];
    const client = {
      updateSchedule: async (id: string, spec: unknown) => {
        calls.push(`update:${id}:${JSON.stringify(spec)}`);
      },
      pauseSchedule: async (id: string) => {
        calls.push(`pause:${id}`);
      },
      resumeSchedule: async (id: string) => {
        calls.push(`resume:${id}`);
      },
      cancelSchedule: async (id: string) => {
        calls.push(`cancel:${id}`);
      },
    };

    await updateScheduleSpec(client, 's1', { cron: '0 2 * * *' });
    await pauseSchedule(client, 's1');
    await resumeSchedule(client, 's1');
    await cancelSchedule(client, 's1');

    expect(calls).toEqual(['update:s1:{"cron":"0 2 * * *"}', 'pause:s1', 'resume:s1', 'cancel:s1']);
  });

  test('updateScheduleSpec forwards revisionPolicy as the update options when supplied', async () => {
    let receivedOptions: unknown;
    const client = {
      updateSchedule: async (_id: string, _spec: unknown, options: unknown) => {
        receivedOptions = options;
      },
    };

    await updateScheduleSpec(client, 's1', { cron: '0 2 * * *' }, { revisionPolicy: 'pinned' });

    expect(receivedOptions).toEqual({ revisionPolicy: 'pinned' });
  });

  test('updateScheduleSpec forwards description, overlap, backfill, and jitter together with revisionPolicy (COR-15)', async () => {
    let receivedOptions: unknown;
    const client = {
      updateSchedule: async (_id: string, _spec: unknown, options: unknown) => {
        receivedOptions = options;
      },
    };
    const options = {
      description: 'Weekly',
      overlap: 'queue',
      backfill: true,
      jitter: '30s',
      revisionPolicy: 'pinned',
    } as const;

    await updateScheduleSpec(client, 's1', { cron: '0 2 * * *' }, options);

    expect(receivedOptions).toEqual(options);
  });

  test('updateScheduleSpec passes undefined options when revisionPolicy is omitted', async () => {
    let receivedOptions: unknown = 'not called';
    const client = {
      updateSchedule: async (_id: string, _spec: unknown, options: unknown) => {
        receivedOptions = options;
      },
    };

    await updateScheduleSpec(client, 's1', { cron: '0 2 * * *' });

    expect(receivedOptions).toBeUndefined();
  });
});

describe('scheduleMissedQueryKey', () => {
  test('is a tuple of its own for the schedule', () => {
    expect(scheduleMissedQueryKey('nightly-rollup')).toEqual([
      'schedules',
      'missed',
      'nightly-rollup',
    ]);
  });
});

type ControlOperations = ScheduleControlClient['operations'];

/** A client whose operations are the ones a test gives, and refuse the rest. */
function controlClient(given: Partial<ControlOperations>): ScheduleControlClient {
  const unused = () => Promise.reject(new Error('unused'));
  return {
    operations: {
      'weft.schedules.runnow': unused,
      'weft.schedules.missed': unused,
      ...given,
    },
  };
}

describe('the engine controls of a schedule', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test('skip next posts to the REST address with the client’s headers, and reads a 204 as done', async () => {
    const seen: { url: string; method: string | undefined; headers: unknown }[] = [];
    restore = installFetchImplementation((input, init) => {
      seen.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        method: init?.method,
        headers: init?.headers,
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    await skipNextSchedule(
      { baseUrl: 'http://host:7399', headers: { Authorization: 'Bearer t' } },
      'a b',
    );

    expect(seen).toEqual([
      {
        url: 'http://host:7399/v1/schedules/a%20b/skip-next',
        method: 'POST',
        headers: { Authorization: 'Bearer t' },
      },
    ]);
  });

  test('skip next raises the refusal as the client does, with its status, message and body', async () => {
    restore = installFetchImplementation(() =>
      Promise.resolve(
        Response.json({ error: 'Schedule is paused', weftCode: 'Conflict' }, { status: 409 }),
      ),
    );

    const refused = await rejectionOf(
      skipNextSchedule({ baseUrl: 'http://host', headers: {} }, 's-1'),
    );

    expect(refused).toBeInstanceOf(HttpClientError);
    expect(refused).toMatchObject({ status: 409, message: 'Schedule is paused' });
  });

  test('skip next keeps the status text when the refusal has no JSON body', async () => {
    restore = installFetchImplementation(() =>
      Promise.resolve(new Response('nope', { status: 502, statusText: 'Bad Gateway' })),
    );

    const refused = await rejectionOf(
      skipNextSchedule({ baseUrl: 'http://host', headers: {} }, 's-1'),
    );

    expect(refused).toMatchObject({ status: 502, message: 'Bad Gateway' });
  });

  test('run now names the run that started, queued, or was in the way', async () => {
    const answers: Record<
      string,
      Awaited<ReturnType<ControlOperations['weft.schedules.runnow']>>
    > = {
      a: { outcome: 'started', workflowId: 'run-1' },
      b: { outcome: 'queued', workflowId: 'run-2' },
      c: { outcome: 'skipped', blockingWorkflowId: 'run-0' },
      d: { outcome: 'skipped' },
    };
    const client = controlClient({
      'weft.schedules.runnow': ({ scheduleId }) =>
        Promise.resolve(answers[scheduleId] ?? { outcome: 'skipped' }),
    });

    expect(await runNowSchedule(client, 'a')).toEqual({ outcome: 'started', runId: 'run-1' });
    expect(await runNowSchedule(client, 'b')).toEqual({ outcome: 'queued', runId: 'run-2' });
    expect(await runNowSchedule(client, 'c')).toEqual({
      outcome: 'skipped',
      blockingRunId: 'run-0',
    });
    expect(await runNowSchedule(client, 'd')).toEqual({ outcome: 'skipped', blockingRunId: null });
  });

  test('missed rows come back as the engine recorded them', async () => {
    const row = { occurrence: 5, reason: 'dst-gap' as const, count: 2, recordedAt: 6 };
    const client = controlClient({
      'weft.schedules.missed': () => Promise.resolve({ missed: [row] }),
    });

    expect(await listScheduleMissed(client, 's-1')).toEqual([row]);
  });
});
