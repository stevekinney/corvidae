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
  /** Steps until `reached` holds; the shared hang guard ends a condition that never does. */
  const stepUntil = (reached: () => Promise<boolean>): Promise<void> =>
    waitUntil(async () => {
      if (await reached()) return true;
      await step();
      return false;
    });
  /** Operative's assessment of the run in `world`, from `bureau.tasks.inspect`. */
  const assessmentIn = async (world: OpenedBureau, taskId: string): Promise<string | undefined> => {
    const body = await rpc(world.handler, 'bureau.tasks.inspect', { taskId }, OWNER_KEY);
    const liveness = body.result?.['liveness'] as { assessment?: string } | null | undefined;
    return liveness?.assessment;
  };
  /** Whether `world`'s engine holds the run's live claim itself. */
  const holdsClaim = async (world: OpenedBureau, taskId: string): Promise<boolean> => {
    const claim = await world.bureau.durableEngine()?.claimHolder(taskId);
    return claim?.heldByThisProcess === true;
  };
  /** What the shared record holds of the task, read through B's registry after its writes settle. */
  const storedOf = async (taskId: string) => {
    await successor.bureau.internals.taskRegistry.flush();
    await holder.bureau.internals.taskRegistry.flush();
    return successor.bureau.internals.taskRegistry.record(taskId);
  };
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
    storedOf,
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
  const stored = await world.storedOf(task.id);
  expect(stored?.settled).toBeUndefined();
  expect(stored?.attention).toBeUndefined();
  return { world, task };
}

describe('a stall written by a process that lost the run (COR-2526)', () => {
  it('(a) is not recorded on the successor’s record, and announces nothing', async () => {
    const { world, task } = await takenOver();

    // A's own watchdog reaches `alive-but-stalled` and writes through its snapshot subscription.
    await world.stepUntil(
      async () => (await world.assessmentIn(world.holder, task.id)) === 'alive-but-stalled',
    );
    const stored = await world.storedOf(task.id);

    expect(world.holderStalled).toEqual([]);
    expect(world.successorStalled).toEqual([]);
    expect(stored?.attention).toBeUndefined();
  });

  it('(b) is not cleared by that process’s late clear, which leaves the successor’s real stall', async () => {
    const { world, task } = await takenOver();

    // The successor's run has a stall, written as its holder. The stall is the successor's own
    // registry write, not its watchdog's: a recovered run takes its liveness clock only from a test
    // seam that nothing outside tests sets (`livenessClock` in `active-run-reattach.ts`), so under
    // this manual clock its assessment stays `healthy` however long the tool call is held.
    const stalledAt = '2026-11-19T12:30:00.000Z';
    const wrote = await world.successor.bureau.internals.taskRegistry.recordStall(
      task.id,
      stalledAt,
    );
    expect(wrote).toBe(true);

    // A's own watchdog reaches the stall, and its write is dropped: the stall is already there.
    await world.stepUntil(
      async () => (await world.assessmentIn(world.holder, task.id)) === 'alive-but-stalled',
    );
    const whileStalled = await world.storedOf(task.id);
    expect(whileStalled?.attention?.stalledSince).toBe(stalledAt);

    // A's tool call returns and its run ends: its assessment leaves the stall, and it writes the
    // clear, which would take the successor's stall off the record if A were still its holder.
    world.toolA.release();
    await waitUntil(
      async () => (await world.assessmentIn(world.holder, task.id)) !== 'alive-but-stalled',
    );
    const afterClear = await world.storedOf(task.id);

    expect(afterClear?.attention?.stalledSince).toBe(stalledAt);
    expect(world.holderStalled).toEqual([]);
  });
});

describe('a retry recorded by a process that lost the run (COR-2531)', () => {
  it('is cleared when the successor recovers the run, and the old holder’s later retry write is refused', async () => {
    const world = await openTakeover();
    const task = await world.holder.bureau.tasks.start('stalling', 'Go.');
    await world.toolA.entered;
    const holderRegistry = world.holder.bureau.internals.taskRegistry;
    // The holder's model step is on its second try when its process is lost.
    expect(await holderRegistry.recordRetrying(task.id, { label: 'model', attempt: 2 })).toBe(true);
    const recorded = await world.storedOf(task.id);
    expect(recorded?.retrying).toEqual({ label: 'model', attempt: 2 });

    // A renews nothing, so its claim lapses and B adopts the run, driving it from its checkpoint.
    await world.stepUntil(() => world.holdsClaim(world.successor, task.id));
    await world.toolB.entered;

    // What the dead holder recorded is stale: the successor does not know a step is retrying.
    await waitUntil(async () => {
      const stored = await world.storedOf(task.id);
      return stored?.retrying === undefined;
    });
    const seen = await world.successor.bureau.tasks.get(task.id);
    expect(seen?.retrying).toBeNull();

    // The old holder, a moment behind, cannot write a retry onto its successor's record.
    expect(await holderRegistry.recordRetrying(task.id, { label: 'model', attempt: 3 })).toBe(
      false,
    );
    const after = await world.storedOf(task.id);
    expect(after?.retrying).toBeUndefined();
  });
});
