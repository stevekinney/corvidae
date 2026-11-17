/**
 * COR-2115 (AC4, owner decision 2026-11-13) — a reattached live run describes its hook plan, so the
 * run page shows the same plan after Bureau restarts as it did before. The reattach adapter is handed
 * a run's recovered services by its caller, and the plan is whatever those services hold; the adapter
 * answers it through `describeHookPlan`, which never throws and never answers a plan it was not given.
 *
 * What `describeHookPlan()` answers for each way a reattached run's plan can be, probed on main
 * (`origin/main` at 3e3d83897, where the adapter's `describeHookPlan` was `() => undefined` whatever
 * the caller held), and what it answers now:
 *
 * | The caller hands it                         | main today | now                      |
 * | ------------------------------------------- | ---------- | ------------------------ |
 * | a plan with two entries                     | undefined  | that plan, both entries  |
 * | a plan with no entries                      | undefined  | that plan, no entries    |
 * | a plan it cannot read (answers `undefined`) | undefined  | undefined                |
 * | a plan that throws when read                | undefined  | undefined, never a throw |
 * | nothing (a reattach outside recovery)       | undefined  | undefined                |
 *
 * The same table in Bureau's terms, which `checks-hook-plan` (`tasks-inspect-hooks.test.ts`) drives
 * over a real Bureau: a live run reads its plan and its failed hooks; a reattached live run reads the
 * plan its recovered services hold, as a fresh one does; a settled run reads its failed hooks and no
 * plan; a hook that failed once, many times or never is one row (or none) with its count; a live
 * run whose plan has no entries and no failure draws nothing; a plan that cannot be read is `null`.
 */
import { HookRegistry, type HookPlanDescription } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';
import { createCheckpointStore } from './checkpoint-store';

import type { ActiveRun } from '../create-run';
import type { OperativeHookMap } from '../hooks';
import { reattachDurableActiveRun } from './active-run-reattach';
import type { RegistryAgnosticEngine } from './create-run-engine';

const runs: ActiveRun[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run[Symbol.dispose]();
});

/** A plan of two registrations, one by a plugin and one by Bureau, as a recovered run holds. */
function twoEntryPlan(): HookPlanDescription {
  const hooks = new HookRegistry<OperativeHookMap>();
  hooks.on('onStep', async () => {}, {
    id: 'acme-audit:redact',
    source: 'acme-audit',
    priority: 100,
  });
  hooks.on('onRunStart', async () => {}, { id: 'onRunStart#1', source: 'bureau', replay: 'safe' });
  return hooks.describePlan();
}

/** A reattached run over a handle that never settles, so it is live for as long as the test looks. */
function reattach(
  describeHookPlan: (() => HookPlanDescription | undefined) | undefined,
): ActiveRun {
  const engine = { cancel: async () => {} } as unknown as RegistryAgnosticEngine;
  const run = reattachDurableActiveRun(
    {
      engine,
      checkpointStore: createCheckpointStore(
        textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false }),
      ),
    },
    {
      runId: 'reattached-run',
      handle: { id: 'reattached-run', result: () => new Promise<never>(() => {}) },
      ...(describeHookPlan === undefined ? {} : { describeHookPlan }),
    },
  );
  runs.push(run);
  return run;
}

describe('a reattached live run’s hook plan', () => {
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly handed: (() => HookPlanDescription | undefined) | undefined;
    readonly answers: (plan: HookPlanDescription | undefined) => void;
  }> = [
    {
      name: 'is the plan its recovered services hold',
      handed: twoEntryPlan,
      answers: (plan) => {
        expect(plan?.entries.map((entry) => [entry.id, entry.hookName, entry.source])).toEqual([
          ['acme-audit:redact', 'onStep', 'acme-audit'],
          ['onRunStart#1', 'onRunStart', 'bureau'],
        ]);
        expect(plan?.entries.map((entry) => [entry.priority, entry.replay])).toEqual([
          [100, 'effectful'],
          [0, 'safe'],
        ]);
      },
    },
    {
      name: 'is a plan with no entries when the recovered plan holds none',
      handed: () => new HookRegistry<OperativeHookMap>().describePlan(),
      answers: (plan) => expect(plan?.entries).toEqual([]),
    },
    {
      name: 'is undefined when the plan cannot be read',
      handed: () => undefined,
      answers: (plan) => expect(plan).toBeUndefined(),
    },
    {
      name: 'is undefined, and never a throw, when reading the plan throws',
      handed: () => {
        throw new Error('the registry is gone');
      },
      answers: (plan) => expect(plan).toBeUndefined(),
    },
    {
      name: 'is undefined when the caller handed it no plan',
      handed: undefined,
      answers: (plan) => expect(plan).toBeUndefined(),
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const run = reattach(row.handed);
      row.answers(run.describeHookPlan());
    });
  }

  it('answers the plan as often as it is asked, and the same one each time', () => {
    const plan = twoEntryPlan();
    const run = reattach(() => plan);
    expect(run.describeHookPlan()).toBe(plan);
    expect(run.describeHookPlan()).toBe(plan);
  });
});
