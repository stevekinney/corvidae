/**
 * COR-2526 — a holder that lost its run's claim does not write on its successor's record. Two
 * Bureaus share one store under `workflow-lease` and one manual clock: A holds a run in a tool call
 * that does not return, its claim lapses (a manual host renews nothing), and B takes the run over
 * and keeps its own claim fresh. A's watchdog, which goes on until its run settles, then writes
 * through its own liveness snapshots; the fence is what keeps those writes off B's record.
 *
 * Time moves in steps of the claim renewal interval, with B's maintenance after each, so B's claim
 * is never lapsed when A reads it: a lapsed claim leaves the writer the holder, by design.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { RunStalledEvent } from './events.ts';
import {
  openBureau,
  type OpenedBureau,
  rpc,
} from './http/management/management-fixtures.test-support.ts';

const ORIGIN = '2026-11-19T12:00:00.000Z';
const OWNER_KEY = 'tasks-operator-key';
/** Under every claim's time-to-live and the renewal interval, so a claim is renewed before it lapses. */
const STEP_MILLISECONDS = 4_000;
/** Enough steps for a tool call that never returns to be assessed stalled, and for a claim to lapse. */
const STEP_LIMIT = 200;

const opened: OpenedBureau[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const bureau of opened.splice(0).toReversed()) await bureau.dispose();
});

/** A tool that holds its call until the test lets it go. */
function holdingTool() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  const tool = createTool({
    name: 'hang',
    description: 'holds until released',
    input: z.object({}),
    async execute() {
      entered.resolve();
      await release.promise;
      return 'ok';
    },
  });
  return {
    toolbox: createToolbox([tool]) as unknown as Toolbox,
    entered: entered.promise,
    release: release.resolve,
  };
}

/** An agent that calls `hang` once and then answers. */
function stallingAgent(toolbox: Toolbox) {
  return createAgent({
    generate: async ({ step }: { step: number }) =>
      step < 1
        ? { content: '', toolCalls: [{ name: 'hang', arguments: {} }] }
        : { content: 'Done.', toolCalls: [] },
    toolbox,
    stopWhen: stopWhen.noToolCalls(),
  });
}

async function openTakeover() {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const storage = new MemoryStorage();
  const bureauOptions = { runtime, durable: true, maintenance: 'manual' } as const;
  const toolA = holdingTool();
  const toolB = holdingTool();
  const holder = await openBureau({
    id: 'holder',
    agents: { stalling: stallingAgent(toolA.toolbox) },
    storage,
    bureauOptions,
  });
  opened.push(holder);
  const successor = await openBureau({
    id: 'successor',
    agents: { stalling: stallingAgent(toolB.toolbox) },
    storage,
    bureauOptions,
  });
  opened.push(successor);
  const stalledOn = (world: OpenedBureau): RunStalledEvent[] => {
    const seen: RunStalledEvent[] = [];
    world.bureau.addEventListener('run.stalled', (event) => seen.push(event));
    return seen;
  };
  const holderStalled = stalledOn(holder);
  const successorStalled = stalledOn(successor);

  /** One step of time, and B's maintenance: it adopts a lapsed claim and renews the ones it holds. */
  const step = async (): Promise<void> => {
    await runtime.advance(STEP_MILLISECONDS);
    await successor.bureau.maintain();
  };
  /** Steps until `reached` holds, or fails the test. */
  const stepUntil = async (reached: () => Promise<boolean>): Promise<void> => {
    for (let count = 0; count < STEP_LIMIT; count += 1) {
      if (await reached()) return;
      await step();
    }
    throw new Error('The condition was not reached within the step limit.');
  };
  /** Operative's assessment of the run in `world`, from `bureau.tasks.inspect`. */
  const assessmentIn = async (world: OpenedBureau, taskId: string): Promise<string | undefined> => {
    const body = await rpc(world.handler, 'bureau.tasks.inspect', { taskId }, OWNER_KEY);
    const liveness = body.result?.['liveness'] as { assessment?: string } | null | undefined;
    return liveness?.assessment;
  };
  /** Whether `world`'s engine holds the run's live claim itself. */
  const holdsClaim = async (world: OpenedBureau, taskId: string): Promise<boolean> =>
    (await world.bureau.durableEngine()?.claimHolder(taskId))?.heldByThisProcess === true;
  const recordOf = (taskId: string) => successor.bureau.internals.taskRegistry.record(taskId);
  return {
    holder,
    successor,
    toolA,
    toolB,
    holderStalled,
    successorStalled,
    step,
    stepUntil,
    assessmentIn,
    holdsClaim,
    recordOf,
  };
}

/** A run A holds in a tool call, taken over by B, which holds it in its own tool call. */
async function takenOver() {
  const world = await openTakeover();
  const task = await world.holder.bureau.tasks.start('stalling', 'Go.');
  await world.toolA.entered;
  expect(await world.holdsClaim(world.holder, task.id)).toBe(true);

  // A renews nothing, so its claim lapses and B adopts the run.
  await world.stepUntil(() => world.holdsClaim(world.successor, task.id));
  await world.toolB.entered;

  // B holds the run now, A still holds it in its own store, and the task has not settled: the
  // fence, not the settlement, is what the rest of each test rests on.
  expect(await world.holdsClaim(world.holder, task.id)).toBe(false);
  expect(world.holder.bureau.tasks.detail(task.id)?.status).toBe('running');
  expect(world.successor.bureau.tasks.detail(task.id)?.status).toBe('running');
  expect((await world.recordOf(task.id))?.settled).toBeUndefined();
  await world.successor.bureau.internals.taskRegistry.flush();
  expect((await world.recordOf(task.id))?.attention).toBeUndefined();
  return { world, task };
}

describe('a stall written by a process that lost the run (COR-2526)', () => {
  it('(a) is not recorded on the successor’s record, and announces nothing', async () => {
    const { world, task } = await takenOver();

    // A's own watchdog reaches `alive-but-stalled` and writes: the successor has not stalled yet.
    await world.stepUntil(async () => (await world.assessmentIn(world.holder, task.id)) === 'alive-but-stalled');
    expect(await world.assessmentIn(world.successor, task.id)).not.toBe('alive-but-stalled');
    await world.holder.bureau.internals.taskRegistry.flush();

    const record = await world.recordOf(task.id);
    expect(record?.attention).toBeUndefined();
    expect(world.holderStalled).toEqual([]);
    expect(world.successorStalled).toEqual([]);
  });

  it('(b) is not cleared by that process’s late clear, which leaves the successor’s real stall', async () => {
    const { world, task } = await takenOver();

    // The successor's run has a stall, written as its holder (a recovered run's liveness is read on
    // the real monotonic clock, which this manual-clock test does not move, so the stall is its own
    // registry's write rather than its watchdog's).
    const stalledAt = '2026-11-19T12:30:00.000Z';
    expect(await world.successor.bureau.internals.taskRegistry.recordStall(task.id, stalledAt)).toBe(
      true,
    );

    // A's own watchdog reaches the stall, and its write is dropped: the stall is already there.
    await world.stepUntil(
      async () => (await world.assessmentIn(world.holder, task.id)) === 'alive-but-stalled',
    );
    await world.holder.bureau.internals.taskRegistry.flush();
    expect((await world.recordOf(task.id))?.attention?.stalledSince).toBe(stalledAt);

    // A's tool call returns and its run ends: its assessment leaves the stall, and it writes the
    // clear, which would take the successor's stall off the record if A were still its holder.
    world.toolA.release();
    await waitUntil(
      async () => (await world.assessmentIn(world.holder, task.id)) !== 'alive-but-stalled',
    );
    await world.holder.bureau.internals.taskRegistry.flush();

    expect((await world.recordOf(task.id))?.attention?.stalledSince).toBe(stalledAt);
    expect(world.holderStalled).toEqual([]);
  });
});
