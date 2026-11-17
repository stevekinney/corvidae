/**
 * COR-2115 (AC4, owner decision 2026-11-13) — a live run that was reattached after its process died
 * shows its full hook plan. The first Bureau stays open across the "restart", as in the other restart
 * tests: two Bureaus share one SQLite file, and the first, held in a step, stands for the process
 * that died there. The second recovers the run, and `bureau.tasks.inspect` reads the plan the
 * recovered run holds and the hooks that threw before the restart, the audit trail being durable.
 *
 * Probed on main (`origin/main` at 3e3d83897): `describeHookPlan()` of the reattached run answered
 * `undefined`, so a live run's plan read `null` after a restart however many hooks it held.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateFunction,
  type OperativeHookMap,
  stopWhen,
} from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  approvalToolbox,
  chargesOnce,
  createScheduleFireHarness,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';

const harness = createScheduleFireHarness();
afterEach(async () => {
  await harness.dispose();
});

/** Parks until the run is aborted, so the run stays live in the life that holds it. */
const parks: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

/** A plugin's plan: a hook at the start of the run that throws, and one that never does. */
function pluginPlan(): HookRegistry<OperativeHookMap> {
  const hooks = new HookRegistry<OperativeHookMap>({
    source: 'acme-audit',
    onError: () => 'continue',
  });
  hooks.on(
    'onRunStart',
    async () => {
      throw new Error('the hook failed');
    },
    { id: 'acme-audit:on-start', replay: 'safe' },
  );
  hooks.on('prepareStep', async () => {}, { id: 'acme-audit:quiet', replay: 'effectful' });
  return hooks;
}

const hookedAgent = () =>
  createAgent({
    name: 'worker',
    generate: parks,
    stopWhen: stopWhen.noToolCalls(),
    hooks: pluginPlan(),
  });

describe('a live run reattached after its process died', () => {
  it('shows the plan its recovered services hold and the hook that threw before the restart', async () => {
    const path = harness.nextDatabasePath();
    const first = await harness.open({
      storage: harness.sqliteHandle(path),
      agents: { worker: hookedAgent() },
    });
    const run = await first.tasks.start('worker', 'go', { principal: OWNER.alice });
    const before = await pollUntil(async () => {
      const inspected = await first.tasks.inspect(run.id);
      return inspected?.hooks.failed.length === 1 ? inspected : undefined;
    }, 'the start hook to throw in the first life');
    expect(before.hooks.plan?.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['acme-audit:on-start', 'acme-audit:quiet']),
    );

    const restarted = await harness.open({
      storage: harness.sqliteHandle(path),
      agents: { worker: hookedAgent() },
    });
    const after = await pollUntil(async () => {
      const inspected = await restarted.tasks.inspect(run.id);
      return inspected?.liveness !== undefined && inspected.hooks.plan !== null
        ? inspected
        : undefined;
    }, 'the reattached run to describe its plan');

    // The plan the recovered run holds, which is what it executes under: the one the run held before
    // the restart, `bureau:pending-approval-persist` included (C3-13: the same section as before).
    const persisting = (entry: { id: string }) => entry.id === 'bureau:pending-approval-persist';
    expect(before.hooks.plan?.some(persisting)).toBe(true);
    expect(after.hooks.plan).toEqual(before.hooks.plan);
    const plugin = after.hooks.plan?.filter((entry) => entry.source === 'acme-audit') ?? [];
    const byId = (first: string[], second: string[]) =>
      String(first[0]).localeCompare(String(second[0]));
    expect(plugin.map((entry) => [entry.id, entry.hookPoint, entry.replay]).toSorted(byId)).toEqual(
      [
        ['acme-audit:on-start', 'onRunStart', 'safe'],
        ['acme-audit:quiet', 'prepareStep', 'effectful'],
      ],
    );
    // What threw before the restart is still on the trail, and is one entry with its source.
    expect(after.hooks.failed.map((hook) => [hook.hookId, hook.source])).toContainEqual([
      'acme-audit:on-start',
      'acme-audit',
    ]);
  });

  it('persists a tool approval its recovered step leaves pending, as a started run does', async () => {
    const path = harness.nextDatabasePath();
    const first = await harness.open({
      storage: harness.sqliteHandle(path),
      agents: {
        worker: createAgent({ name: 'worker', generate: parks, stopWhen: stopWhen.noToolCalls() }),
      },
    });
    const run = await first.tasks.start('worker', 'go', { principal: OWNER.alice });
    await pollUntil(async () => {
      const inspected = await first.tasks.inspect(run.id);
      return inspected?.liveness;
    }, 'the run to be live');

    // The restarted process resumes the run at its first step, which now calls a tool that waits
    // on an operator.
    const restarted = await harness.open({
      storage: harness.sqliteHandle(path),
      agents: {
        worker: createAgent({
          name: 'worker',
          generate: chargesOnce,
          toolbox: approvalToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    const review = await reviewOf(restarted, run.id);

    // The review the run left pending is recorded on its session, where a second restart reads it.
    const recorded = await pollUntil(async () => {
      const session = await restarted.contexts.get(run.contextId);
      const overrides = session?.metadata['pendingApprovalOverrides'];
      return typeof overrides === 'object' && overrides !== null && review.id in overrides
        ? overrides
        : undefined;
    }, 'the recovered run’s pending approval to be recorded on its session');
    expect(Object.keys(recorded)).toContain(review.id);
  });
});
