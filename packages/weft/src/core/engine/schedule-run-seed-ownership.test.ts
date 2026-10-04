/**
 * Who owns what a scheduled occurrence seeds before its start (COR-1408).
 *
 * `startScheduledRun` puts an occurrence's `ctx.services` and its terminal-cleanup
 * membership in engine memory before it calls `startWorkflow`, so a run that finishes
 * inline still schedules the durable cleanup timer. When the start rejects, the occurrence
 * takes back what it seeded, and only that: the id may by then belong to another launch, a
 * start still in flight, a live run, or a launch that began after this one's start rolled
 * itself back. A release that removes what it does not own strips the winning launch of its
 * services and of the obligation that makes terminalization schedule the cleanup timer.
 *
 * Two launches of one workflow id reach the seam with a terminal handoff and a cadence tick
 * draining the same queued run, or a scheduled occurrence reaching for an id `engine.start`
 * already runs. Each case below crosses one interleaving of those launches with one way the
 * services resolver can answer. The winning launch keeps its services, by identity, and its
 * obligation; the loser leaves nothing behind; and no seed ownership record outlives the
 * entries it describes.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { createDeferred, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec/api.ts';
import type { EngineOptions, ScheduleState } from '../types.ts';
import { createScheduleCallbacks } from './callback-creators-schedule.ts';
import { parkedOnSignal } from './checkpoint-conflict.test-support.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { startScheduledRun } from './schedule-run.ts';
import type { ScheduleCallbacks } from './schedules.ts';

/** How the services resolver answers the launches of one case, in the order it is consulted. */
type ResolutionKind = 'distinct' | 'same' | 'unavailable' | 'none';

const RESOLUTION_KINDS: readonly ResolutionKind[] = ['distinct', 'same', 'unavailable', 'none'];

const RESOLUTION_LABELS: Record<ResolutionKind, string> = {
  distinct: 'a distinct services value for each launch',
  same: 'the same services value for every launch',
  unavailable: 'unavailable services',
  none: 'no resolver',
};

function createResolutions(kind: ResolutionKind) {
  const shared = { owner: 'the one value every launch resolves' };
  const resolved: object[] = [];
  const resolveWorkflowServices: EngineOptions['resolveWorkflowServices'] | undefined =
    kind === 'none'
      ? undefined
      : () => {
          if (kind === 'unavailable') {
            return { status: 'unavailable', reason: 'no services for this launch' };
          }
          const services =
            kind === 'same' ? shared : { owner: `resolution ${resolved.length + 1}` };
          resolved.push(services);
          return { status: 'available', services };
        };
  return {
    resolveWorkflowServices,
    /** What launch `index` (the order the resolver was consulted in) holds when it wins. */
    servicesOfLaunch(index: number): unknown {
      if (kind === 'distinct') return resolved[index];
      return kind === 'same' ? shared : undefined;
    },
  };
}

type Holdings = {
  attempt: unknown;
  checkpoint: unknown;
  services: unknown;
  cleanupTracked: boolean;
  pendingStart: boolean;
};

const NOTHING_HELD: Holdings = {
  attempt: undefined,
  checkpoint: undefined,
  services: undefined,
  cleanupTracked: false,
  pendingStart: false,
};

/** What the launch that holds the id is owed: a scheduled launch, or a live `engine.start` run. */
type Winner = { kind: 'launch'; index: number } | { kind: 'live'; services: object };

type LaunchHooks = {
  /** Runs when the launch reaches `startWorkflow`, with its seed already in engine memory. */
  atStart?: () => void;
  /** Runs once `startWorkflow` rejected, before the launch's own catch resumes. */
  afterRejection?: () => Promise<void>;
};

async function settle(promise: Promise<string>): Promise<PromiseSettledResult<string>> {
  try {
    return { status: 'fulfilled', value: await promise };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function rejectionReason(outcome: PromiseSettledResult<string>): unknown {
  if (outcome.status !== 'rejected') {
    throw new Error(`Expected the launch to reject, but it resolved with ${outcome.value}`);
  }
  return outcome.reason;
}

function expectLaunched(outcome: PromiseSettledResult<string>): void {
  if (outcome.status !== 'fulfilled') {
    throw new Error(
      `Expected the launch to succeed, but it rejected with ${Bun.inspect(outcome.reason)}`,
    );
  }
}

/** `wf-cleanup:` is `KEYS.terminalCleanup`'s prefix; each entry's value is the workflow id. */
async function countCleanupTimers(storage: MemoryStorage, workflowId: string): Promise<number> {
  let count = 0;
  for await (const [, value] of storage.scan('wf-cleanup:')) {
    if (decode(value) === workflowId) count += 1;
  }
  return count;
}

async function createHarness(id: string, kind: ResolutionKind) {
  const resolutions = createResolutions(kind);
  const storage = new MemoryStorage();
  const engine = await Engine.create({
    storage,
    recover: false,
    ...(resolutions.resolveWorkflowServices === undefined
      ? {}
      : { resolveWorkflowServices: resolutions.resolveWorkflowServices }),
  });
  engine.register(parkedOnSignal(id));
  const internals = getInternals(engine);
  const schedule = { id: `${id}-schedule`, workflowType: id, input: null } as ScheduleState;
  const baseCallbacks = createScheduleCallbacks(engine);
  let disposed = false;

  function holdings(): Holdings {
    return {
      attempt: currentExecutionAttempt(internals, id),
      checkpoint: internals.checkpoints.get(id),
      services: internals.workflowServices.get(id),
      cleanupTracked: internals.workflowsNeedingTerminalCleanup.has(id),
      pendingStart: internals.pendingStarts.has(id),
    };
  }

  /** Launch one scheduled occurrence of the id, and report how its start settled. */
  function launch(hooks: LaunchHooks = {}): Promise<PromiseSettledResult<string>> {
    const callbacks = {
      ...baseCallbacks,
      startWorkflow: async (...startArguments: Parameters<ScheduleCallbacks['startWorkflow']>) => {
        hooks.atStart?.();
        try {
          await baseCallbacks.startWorkflow(...startArguments);
        } catch (error) {
          await hooks.afterRejection?.();
          throw error;
        }
      },
    };
    return settle(startScheduledRun(internals, schedule, callbacks, { workflowId: id }));
  }

  /** Make the next create commit refuse, after the start adopted its launch checkpoint. */
  function refuseNextCreateCommit(): Error {
    const refusal = new Error('the create commit was refused');
    let armed = true;
    internals.storage = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (armed && (property === 'batch' || property === 'conditionalBatch')) {
          return () => {
            armed = false;
            return Promise.reject(refusal);
          };
        }
        return original.bind(target);
      },
    });
    return refusal;
  }

  return {
    id,
    kind,
    storage,
    engine,
    internals,
    resolutions,
    holdings,
    launch,
    refuseNextCreateCommit,
    async dispose() {
      if (disposed) return;
      disposed = true;
      internals.storage = storage;
      await engine[Symbol.asyncDispose]();
    },
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

function expectSameHoldings(actual: Holdings, expected: Holdings): void {
  expect(actual.attempt).toBe(expected.attempt);
  expect(actual.checkpoint).toBe(expected.checkpoint);
  expect(actual.services).toBe(expected.services);
  expect(actual.cleanupTracked).toBe(expected.cleanupTracked);
  expect(actual.pendingStart).toBe(expected.pendingStart);
}

function expectNothingHeld(harness: Harness): void {
  expectSameHoldings(harness.holdings(), NOTHING_HELD);
  expect(harness.internals.workflowServices.has(harness.id)).toBe(false);
  expect(harness.internals.workflowsNeedingTerminalCleanup.has(harness.id)).toBe(false);
}

/**
 * The interleavings of two launches of one workflow id. Each drives the launches to the point
 * where one holds the id, checks what the loser left behind, and names the winner.
 */
const interleavings: readonly {
  label: string;
  run: (harness: Harness) => Promise<Winner>;
}[] = [
  {
    label: 'launch A is rejected before launch B seeds',
    async run(harness) {
      const refusal = harness.refuseNextCreateCommit();

      const first = await harness.launch();

      expect(rejectionReason(first)).toBe(refusal);
      expectNothingHeld(harness);
      expect(harness.internals.scheduledSeedOwners.size).toBe(0);

      expectLaunched(await harness.launch());
      return { kind: 'launch', index: 1 };
    },
  },
  {
    label: 'launch A rolls back, launch B seeds, then launch A releases its seed',
    async run(harness) {
      const refusal = harness.refuseNextCreateCommit();
      const bothSeeded = createDeferred();
      let rolledBack: Pick<Holdings, 'services' | 'cleanupTracked'> | undefined;
      let seenByRelease: Pick<Holdings, 'services' | 'cleanupTracked'> | undefined;
      let second: Promise<PromiseSettledResult<string>> | undefined;

      const first = await harness.launch({
        afterRejection: async () => {
          // The start adopted a checkpoint and rolled back everything it held for the id,
          // the seed included, before it rejected. Launch B now seeds the id afresh, and
          // launch A's catch resumes only once B holds it.
          const { services, cleanupTracked } = harness.holdings();
          rolledBack = { services, cleanupTracked };
          second = harness.launch({ atStart: () => bothSeeded.resolve() });
          await bothSeeded.promise;
          const held = harness.holdings();
          seenByRelease = { services: held.services, cleanupTracked: held.cleanupTracked };
        },
      });

      expect(rejectionReason(first)).toBe(refusal);
      expect(rolledBack).toEqual({ services: undefined, cleanupTracked: false });
      // Launch B held the id when launch A's catch was about to run, and still does after it.
      const seededByB = harness.resolutions.servicesOfLaunch(1);
      expect(seenByRelease?.cleanupTracked).toBe(true);
      expect(seenByRelease?.services).toBe(seededByB);
      const afterRelease = harness.holdings();
      expect(afterRelease.cleanupTracked).toBe(true);
      expect(afterRelease.services).toBe(seededByB);

      expectLaunched(await (second ?? Promise.reject(new Error('launch B never started'))));
      return { kind: 'launch', index: 1 };
    },
  },
  {
    label:
      'launch A rolls back, a live engine.start run takes the id, then launch A releases its seed',
    async run(harness) {
      const refusal = harness.refuseNextCreateCommit();
      const services = { owner: 'the live run' };

      const first = await harness.launch({
        afterRejection: async () => {
          // Nothing but the rollback told the engine that launch A no longer owns the id.
          await harness.engine.start(harness.id, null, { id: harness.id, services });
        },
      });

      expect(rejectionReason(first)).toBe(refusal);
      expect(harness.holdings().services).toBe(services);
      expect(harness.holdings().cleanupTracked).toBe(true);
      return { kind: 'live', services };
    },
  },
  {
    label: 'launch B is rejected as a duplicate while launch A is in flight',
    async run(harness) {
      // A terminal handoff and a cadence tick draining the same queued run: the first to
      // reach startWorkflow reserves the id, and the other rejects against that reservation.
      const first = harness.launch();
      const second = harness.launch();

      expectLaunched(await first);
      expect(rejectionReason(await second)).toBeInstanceOf(WorkflowAlreadyExistsError);
      return { kind: 'launch', index: 0 };
    },
  },
  {
    label: 'launch A succeeds and launch B is rejected',
    async run(harness) {
      expectLaunched(await harness.launch());
      const beforeSecond = harness.holdings();

      const second = await harness.launch();

      expect(rejectionReason(second)).toBeInstanceOf(WorkflowAlreadyExistsError);
      expectSameHoldings(harness.holdings(), beforeSecond);
      return { kind: 'launch', index: 0 };
    },
  },
  {
    label: 'a scheduled occurrence targets an id a live engine.start run holds',
    async run(harness) {
      const services = { owner: 'the live run' };
      await harness.engine.start(harness.id, null, { id: harness.id, services });
      await waitForCondition(() => harness.internals.parkedInlineWorkflows.has(harness.id), {
        label: `${harness.id} parked on its signal`,
      });
      const beforeOccurrence = harness.holdings();

      const occurrence = await harness.launch();

      expect(rejectionReason(occurrence)).toBeInstanceOf(WorkflowAlreadyExistsError);
      expectSameHoldings(harness.holdings(), beforeOccurrence);
      return { kind: 'live', services };
    },
  },
];

describe('what a scheduled start releases when it is rejected', () => {
  for (const interleaving of interleavings) {
    for (const kind of RESOLUTION_KINDS) {
      it(`${interleaving.label}, with ${RESOLUTION_LABELS[kind]}`, async () => {
        const id = 'seed-ownership-run';
        const harness = await createHarness(id, kind);
        const { engine, internals, storage } = harness;
        try {
          const winner = await interleaving.run(harness);

          // A scheduled launch fails at once when its services are unavailable; every other
          // winner is parked on its signal.
          const parked = winner.kind === 'live' || kind !== 'unavailable';
          const expectedServices =
            winner.kind === 'live'
              ? winner.services
              : harness.resolutions.servicesOfLaunch(winner.index);

          if (parked) {
            await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
              label: `${id} parked on its signal`,
            });
            // The winner keeps its own services object, and the obligation to schedule the
            // durable terminal cleanup.
            expect(internals.workflowServices.get(id)).toBe(expectedServices);
            expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);
            expect(internals.pendingStarts.has(id)).toBe(false);

            await engine.signal(id, 'go', 'the winner');
            expect(await engine.getHandle(id).result()).toBe('the winner');
          }

          // Terminalization scheduled the durable cleanup timer, which is what the obligation
          // exists to guarantee.
          const state = await engine.get(id);
          expect(state?.status).toBe(parked ? 'completed' : 'failed');
          expect(state?.terminalCleanupToken).toBeDefined();
          expect(await countCleanupTimers(storage, id)).toBe(1);

          // Terminalization released everything the id held, ownership records included.
          expectNothingHeld(harness);
          expect(internals.scheduledSeedOwners.size).toBe(0);

          // So does purging the terminal run.
          const purged = await engine.purge({ status: state?.status });
          expect(purged.deleted).toBe(1);
          expectNothingHeld(harness);
          expect(internals.scheduledSeedOwners.size).toBe(0);
        } finally {
          await harness.dispose();
        }
      });
    }
  }

  for (const kind of RESOLUTION_KINDS.filter((candidate) => candidate !== 'unavailable')) {
    it(`leaves no ownership record behind when the engine is disposed with the winner running, with ${RESOLUTION_LABELS[kind]}`, async () => {
      const id = 'seed-ownership-disposal';
      const harness = await createHarness(id, kind);
      try {
        expectLaunched(await harness.launch());
        await waitForCondition(() => harness.internals.parkedInlineWorkflows.has(id), {
          label: `${id} parked on its signal`,
        });
        // The launch seeded the id, so the engine recorded who owns what it seeded.
        expect(harness.internals.scheduledSeedOwners.has(id)).toBe(true);

        await harness.dispose();

        expect(harness.internals.scheduledSeedOwners.size).toBe(0);
        expect(harness.internals.workflowServices.size).toBe(0);
      } finally {
        await harness.dispose();
      }
    });
  }
});
