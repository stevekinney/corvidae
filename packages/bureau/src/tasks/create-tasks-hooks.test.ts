/**
 * COR-2115 — what `inspect` says of a run's hooks when its plan has no entry, cannot be read, or the
 * run has ended, and how the failures of one registration are counted: once, many times, and never
 * (the rows `http/management/tasks-inspect-hooks.test.ts` lists, below the wire).
 */
import type { HookPlanDescription } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import type { AuditRecord, AuditTrail } from '../audit-trail.ts';
import { createTasks, INSPECTED_HOOK_LIMIT, type TasksDependencies } from './create-tasks.ts';
import { MAXIMUM_FAILED_HOOKS, readFailedHooks } from './failed-hooks.ts';

const noEntries: HookPlanDescription = { revision: 1, entries: [] };

function task(status: string) {
  return { id: 'run-1', status } as never;
}

/** `createTasks` over a task in `status`, a plan read by `hookPlan`, and failures from `failed`. */
function inspectionOf(
  status: string,
  hookPlan: () => HookPlanDescription | undefined,
  failed: TasksDependencies['failedHooks'] = async () => [],
) {
  const tasks = createTasks({
    registry: { get: async () => task(status) } as never,
    children: { list: async () => [] },
    steps: async () => [],
    detail: () => undefined,
    hookPlan,
    failedHooks: failed,
  } as never);
  return tasks.inspect('run-1');
}

describe('the hook plan of a run being inspected', () => {
  it.each(['submitted', 'working', 'input-required'])(
    'is the plan, field by field, for a run that is %s',
    async (status) => {
      const inspection = await inspectionOf(status, () => ({
        revision: 3,
        entries: [
          {
            hookName: 'beforeToolExecution',
            id: 'acme-audit:redact',
            priority: 1100,
            replay: 'effectful',
            source: 'acme-audit',
            // A field a registration gains later reaches no client until it is added on purpose.
            tier: 'agent',
            secret: 'never leaves',
          } as never,
          { hookName: 'onRunStart', id: 'onRunStart#1', priority: 1000, replay: 'safe' },
        ],
      }));

      expect(inspection?.hooks.plan).toEqual([
        {
          id: 'acme-audit:redact',
          hookPoint: 'beforeToolExecution',
          source: 'acme-audit',
          priority: 1100,
          replay: 'effectful',
        },
        {
          id: 'onRunStart#1',
          hookPoint: 'onRunStart',
          source: null,
          priority: 1000,
          replay: 'safe',
        },
      ]);
      expect(JSON.stringify(inspection?.hooks)).not.toContain('never leaves');
    },
  );

  it('is an empty list, not a missing plan, for a live run whose plan holds no entry', async () => {
    const inspection = await inspectionOf('working', () => noEntries);
    expect(inspection?.hooks.plan).toEqual([]);
  });

  it('is null for a live run whose plan cannot be read, whether it answers nothing or throws', async () => {
    const silent = await inspectionOf('working', () => undefined);
    const throwing = await inspectionOf('working', () => {
      throw new Error('the registry is gone');
    });
    expect(silent?.hooks.plan).toBeNull();
    expect(throwing?.hooks.plan).toBeNull();
  });

  it.each(['completed', 'failed', 'canceled'])(
    'is null for a run that is %s, however the run still describes one',
    async (status) => {
      let asked = false;
      const inspection = await inspectionOf(status, () => {
        asked = true;
        return noEntries;
      });
      expect(inspection?.hooks.plan).toBeNull();
      expect(asked).toBe(false);
    },
  );

  it('lists no more registrations than the bound, and every one of them cut to its text limit', async () => {
    const entries = Array.from({ length: INSPECTED_HOOK_LIMIT + 25 }, (_, index) => ({
      hookName: 'onStep',
      id: `${'x'.repeat(400)}-${String(index)}`,
      priority: 0,
      replay: 'safe' as const,
    }));
    const inspection = await inspectionOf('working', () => ({ revision: 1, entries }));
    const plan = inspection?.hooks.plan;

    expect(plan).toHaveLength(INSPECTED_HOOK_LIMIT);
    expect(plan?.every((entry) => entry.id.length <= 256)).toBe(true);
  });

  it('reports the failures the run’s trail holds beside the plan, for a settled run too', async () => {
    const failure = {
      hookId: 'acme-audit:redact',
      hookPoint: 'beforeToolExecution',
      source: 'acme-audit',
      count: 3,
      lastFailedAt: '2026-11-02T16:42:00.000Z',
    };
    for (const status of ['working', 'completed']) {
      const inspection = await inspectionOf(
        status,
        () => noEntries,
        async () => [failure],
      );
      expect(inspection?.hooks.failed).toEqual([failure]);
    }
  });
});

/** A trail answering the records of one run, a page at a time as the real one does. */
function trailOf(records: readonly Partial<AuditRecord>[]): {
  trail: Pick<AuditTrail, 'query'>;
  queries: unknown[];
} {
  const queries: unknown[] = [];
  const all = records.map((record, index) => ({
    timestamp: new Date(1_000 + (record.timestampMs ?? index)).toISOString(),
    timestampMs: 1_000 + index,
    sequence: index,
    runId: 'run-1',
    type: 'hook-plan.failed',
    detail: {},
    ...record,
  })) as AuditRecord[];
  return {
    queries,
    trail: {
      query: async (options) => {
        queries.push(options);
        const after = options?.after;
        const matching = all.filter(
          (record) =>
            record.runId === options?.runId &&
            record.type === options?.type &&
            (after === undefined || (record.sequence ?? -1) > after.sequence),
        );
        return matching.slice(0, options?.limit ?? 500);
      },
    },
  };
}

const failure = (hookId: string, extra: Record<string, unknown> = {}, at?: number) => ({
  ...(at === undefined ? {} : { timestampMs: at }),
  detail: {
    step: 0,
    hookId,
    hookName: 'onStep',
    source: 'acme-audit',
    error: `the hook failed ${hookId}`,
    ...extra,
  },
});

describe('the hooks of a run that threw', () => {
  it('is one entry for a registration that threw once, many times, with its count and its latest time, and none for one that never did', async () => {
    const { trail } = trailOf([
      failure('acme-audit:often', {}, 100),
      failure('acme-audit:once', {}, 200),
      failure('acme-audit:often', {}, 300),
      failure('acme-audit:often', {}, 400),
    ]);

    const failed = await readFailedHooks(trail, 'run-1');

    expect(failed.map((hook) => [hook.hookId, hook.count])).toEqual([
      ['acme-audit:often', 3],
      ['acme-audit:once', 1],
    ]);
    // Most recent failure first, and the time is the latest one of that registration.
    expect(failed[0]?.lastFailedAt).toBe(new Date(400).toISOString());
    expect(failed[1]?.lastFailedAt).toBe(new Date(200).toISOString());
  });

  it('is empty for a run that threw nothing, for another run’s failures, and for a Bureau that keeps no trail', async () => {
    const { trail } = trailOf([{ ...failure('acme-audit:often'), runId: 'run-2' }]);
    expect(await readFailedHooks(trail, 'run-1')).toEqual([]);
    expect(await readFailedHooks(undefined, 'run-1')).toEqual([]);
  });

  it('names the registration, the hook point and who registered it, and nothing of the error', async () => {
    const { trail } = trailOf([
      failure('acme-audit:often', { stack: 'at secret.ts:1', cause: 'x' }),
    ]);

    const failed = await readFailedHooks(trail, 'run-1');

    expect(failed).toHaveLength(1);
    expect(Object.keys(failed[0]!).toSorted()).toEqual(
      ['count', 'hookId', 'hookPoint', 'lastFailedAt', 'source'].toSorted(),
    );
    expect(JSON.stringify(failed)).not.toContain('secret.ts');
    expect(JSON.stringify(failed)).not.toContain('the hook failed');
  });

  it('says a registration nobody registered as no source, and leaves out a record that names no registration or no hook point', async () => {
    const { trail } = trailOf([
      failure('anonymous', { source: undefined }),
      failure('no-point', { hookName: undefined }),
      { detail: { hookName: 'onStep' } },
      { detail: null },
      failure('bad-source', { source: 7 }),
    ]);

    const failed = await readFailedHooks(trail, 'run-1');

    const byId = (first: unknown[], second: unknown[]) =>
      String(first[0]).localeCompare(String(second[0]));
    expect(failed.map((hook) => [hook.hookId, hook.source]).toSorted(byId)).toEqual([
      ['anonymous', null],
      ['bad-source', null],
    ]);
  });

  it('reads every page of a run whose hook threw on every step, and counts them all', async () => {
    const { trail, queries } = trailOf(
      Array.from({ length: 1_200 }, () => failure('acme-audit:often')),
    );

    const failed = await readFailedHooks(trail, 'run-1');

    expect(failed).toHaveLength(1);
    expect(failed[0]?.count).toBe(1_200);
    expect(queries.length).toBeGreaterThan(2);
  });

  it('lists no more registrations than the bound, newest failure first', async () => {
    const { trail } = trailOf(
      Array.from({ length: MAXIMUM_FAILED_HOOKS + 10 }, (_, index) =>
        failure(`hook-${String(index)}`, {}, index),
      ),
    );

    const failed = await readFailedHooks(trail, 'run-1');

    expect(failed).toHaveLength(MAXIMUM_FAILED_HOOKS);
    expect(failed[0]?.hookId).toBe(`hook-${String(MAXIMUM_FAILED_HOOKS + 9)}`);
  });
});
