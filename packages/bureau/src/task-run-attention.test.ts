/**
 * COR-2526 — whether a run is stalled or looping is a fact on its task record, which a process that
 * does not hold the run reads and the task list filters on. Operative's own assessment decides
 * `stalled` (`alive-but-stalled`, never a threshold of the Bureau's); the Bureau records it from the
 * run's liveness snapshots, stamped with its own clock, once for each stall.
 *
 * Time is the Bureau's manual runtime, advanced one tool-call check interval (the cadence, the
 * grace and the jitter of `TOOL_CALL_POLICY`) at a time: a single larger step reads as a suspended
 * process, which accrues no missed pulse. Two Bureaus share the storage and the runtime: A holds the
 * runs, and B is the process that does not.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen, TOOL_CALL_POLICY } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { RunLoopingEvent, RunStalledEvent } from './events.ts';
import {
  openBureau,
  type OpenedBureau,
  rpc,
} from './http/management/management-fixtures.test-support.ts';
import type { TaskView } from './task-registry.ts';

/** One check of the tool-call watchdog: its cadence, its grace and its jitter. */
const CHECK_MILLISECONDS =
  (TOOL_CALL_POLICY.cadenceMs ?? 0) + TOOL_CALL_POLICY.graceMs + TOOL_CALL_POLICY.jitterMs;
const ORIGIN = '2026-11-19T12:00:00.000Z';
const OWNER_KEY = 'tasks-operator-key';

const opened: OpenedBureau[] = [];
afterEach(async () => {
  for (const bureau of opened.splice(0).toReversed()) await bureau.dispose();
});

/** One field of a task, as `bureau.tasks.get` shows it from `bureau`. */
async function fieldOf<K extends keyof TaskView>(
  bureau: OpenedBureau['bureau'],
  taskId: string,
  key: K,
): Promise<TaskView[K] | undefined> {
  const view = await bureau.tasks.get(taskId);
  return view?.[key];
}

/** What `bureau`'s registry stored of a task's attention, or `undefined` for none. */
async function storedAttentionOf(bureau: OpenedBureau['bureau'], taskId: string) {
  const record = await bureau.internals.taskRegistry.record(taskId);
  return record?.attention;
}

/** Whether `bureau` shows the task as stalled. */
async function isStalled(bureau: OpenedBureau['bureau'], taskId: string): Promise<boolean> {
  const attention = await fieldOf(bureau, taskId, 'attention');
  return attention?.includes('stalled') === true;
}

/** The tasks a `bureau.tasks.list` call answered, as their id and their attention. */
async function listedBy(
  handler: OpenedBureau['handler'],
  params: Record<string, unknown>,
): Promise<ReadonlyArray<readonly [string, readonly string[]]>> {
  const body = await rpc(handler, 'bureau.tasks.list', params, OWNER_KEY);
  const tasks = (body.result?.['tasks'] ?? []) as Array<{ id: string; attention: string[] }>;
  return tasks.map((task) => [task.id, task.attention] as const);
}

/** A tool that holds each call until the test lets it go, and says when a call began. */
function holdingTool(calls: number) {
  const entered = Array.from({ length: calls }, () => Promise.withResolvers<void>());
  const release = Array.from({ length: calls }, () => Promise.withResolvers<void>());
  let index = 0;
  const tool = createTool({
    name: 'hang',
    description: 'holds until released',
    input: z.object({}),
    async execute() {
      const call = index;
      index += 1;
      entered[call]?.resolve();
      await release[call]?.promise;
      return 'ok';
    },
  });
  return {
    toolbox: createToolbox([tool]) as unknown as Toolbox,
    entered: (call: number) => entered[call]!.promise,
    release: (call: number) => release[call]!.resolve(),
  };
}

/** An agent that calls `hang` on its first `holds` steps and then answers. */
function stallingAgent(holds: number, toolbox: Toolbox) {
  return createAgent({
    generate: async ({ step }: { step: number }) =>
      step < holds
        ? { content: '', toolCalls: [{ name: 'hang', arguments: {} }] }
        : { content: 'Done.', toolCalls: [] },
    toolbox,
    stopWhen: stopWhen.noToolCalls(),
  });
}

async function open(holds: number, durable = false) {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const storage = new MemoryStorage();
  const tool = holdingTool(holds);
  const bureauOptions = { runtime, durable, maintenance: 'manual' } as const;
  const holder = await openBureau({
    agents: {
      stalling: stallingAgent(holds, tool.toolbox),
      quick: createAgent({
        generate: async () => ({ content: 'Done.', toolCalls: [] }),
        toolbox: createToolbox([]) as unknown as Toolbox,
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage,
    bureauOptions,
  });
  opened.push(holder);
  // The process that does not hold the runs: the same store and clock, and no run of its own.
  const peer = await openBureau({ storage, bureauOptions });
  opened.push(peer);
  const stalled: RunStalledEvent[] = [];
  holder.bureau.addEventListener('run.stalled', (event) => stalled.push(event));
  const advanceChecks = async (count: number): Promise<void> => {
    for (let check = 0; check < count; check += 1) await runtime.advance(CHECK_MILLISECONDS);
  };
  return {
    holder,
    peer,
    runtime,
    tool,
    stalled,
    advanceChecks,
    /** Whether the peer, which holds no run, shows the task as stalled. */
    peerSeesStalled: (taskId: string) => isStalled(peer.bureau, taskId),
    /** One field of a task as the peer shows it. */
    peerField: <K extends keyof TaskView>(taskId: string, key: K) =>
      fieldOf(peer.bureau, taskId, key),
    peerStoredAttention: (taskId: string) => storedAttentionOf(peer.bureau, taskId),
  };
}

describe('a stalled run (COR-2526)', () => {
  it('(g) is recorded once, with the instant the Bureau saw it, and read by a process that does not hold the run', async () => {
    const world = await open(1);
    const task = await world.holder.bureau.tasks.start('stalling', 'Go.');
    await world.tool.entered(0);

    // Two missed pulses are late, not stalled: Operative's own threshold decides, not the Bureau's.
    await world.advanceChecks(2);
    expect(await world.peerField(task.id, 'attention')).toEqual([]);

    await world.advanceChecks(1);
    await waitUntil(() => world.peerSeesStalled(task.id));
    const view = await world.peer.bureau.tasks.get(task.id);
    expect(view?.attention).toEqual(['stalled']);
    expect(view?.status).toBe('working');
    // The Bureau's own clock when the third check passed, not a monotonic reading.
    const expected = new Date(Date.parse(ORIGIN) + 3 * CHECK_MILLISECONDS).toISOString();
    expect(view?.stalledSince).toBe(expected);

    // The silence goes on and the assessment does not change: nothing is written or announced again.
    await world.advanceChecks(3);
    await world.holder.bureau.internals.taskRegistry.flush();
    expect(await world.peerField(task.id, 'stalledSince')).toBe(expected);
    expect(world.stalled.map((event) => [event.runId, event.since])).toEqual([[task.id, expected]]);

    world.tool.release(0);
    await task.result();
  });

  it('(g) on the durable engine too: recorded once, and cleared when the call returns', async () => {
    const world = await open(1, true);
    const task = await world.holder.bureau.tasks.start('stalling', 'Go.');
    await world.tool.entered(0);
    await world.advanceChecks(3);
    await waitUntil(() => world.peerSeesStalled(task.id));
    await world.advanceChecks(2);
    expect(world.stalled).toHaveLength(1);

    world.tool.release(0);
    await task.result();
    await world.holder.bureau.internals.whenTaskRecorded(task.id);
    await world.holder.bureau.internals.taskRegistry.flush();
    expect(await world.peerField(task.id, 'attention')).toEqual([]);
    expect(world.stalled).toHaveLength(1);
  });

  it('(h) clears when progress resumes, and a second stall is a new episode', async () => {
    const world = await open(2);
    const task = await world.holder.bureau.tasks.start('stalling', 'Go.');
    await world.tool.entered(0);
    await world.advanceChecks(3);
    await waitUntil(() => world.peerSeesStalled(task.id));
    const first = await world.peerField(task.id, 'stalledSince');

    // The tool call returns: the watchdog ends, the assessment changes, the record clears.
    world.tool.release(0);
    await world.tool.entered(1);
    await waitUntil(async () => {
      const attention = await world.peerField(task.id, 'attention');
      return attention?.length === 0;
    });
    expect(await world.peerField(task.id, 'stalledSince')).toBeNull();

    // The next call goes silent too: a new episode, announced again.
    await world.advanceChecks(3);
    await waitUntil(() => world.peerSeesStalled(task.id));
    const second = await world.peerField(task.id, 'stalledSince');
    expect(second).not.toBe(first);
    expect(world.stalled).toHaveLength(2);

    world.tool.release(1);
    await task.result();
  });

  it('AC2, AC5, AC7: lists only the stalled task by `attention`, and reads none once it settles', async () => {
    const world = await open(1);
    const stalling = await world.holder.bureau.tasks.start('stalling', 'Go.');
    const quick = await world.holder.bureau.tasks.start('quick', 'Go.');
    await quick.result();
    await world.tool.entered(0);
    await world.advanceChecks(3);
    await waitUntil(() => world.peerSeesStalled(stalling.id));

    const everything = await listedBy(world.peer.handler, {});
    expect(everything.map(([id]) => id).toSorted()).toEqual([stalling.id, quick.id].toSorted());
    expect(await listedBy(world.peer.handler, { attention: 'stalled' })).toEqual([
      [stalling.id, ['stalled']],
    ]);
    expect(await listedBy(world.peer.handler, { attention: 'looping' })).toEqual([]);

    // The stall ends with the run: a settled task is listed by neither kind.
    world.tool.release(0);
    await stalling.result();
    await world.holder.bureau.internals.whenTaskRecorded(stalling.id);
    await world.holder.bureau.internals.taskRegistry.flush();
    expect(await world.peerField(stalling.id, 'attention')).toEqual([]);
    expect(await world.peerField(stalling.id, 'stalledSince')).toBeNull();
    expect(await listedBy(world.peer.handler, { attention: 'stalled' })).toEqual([]);
  });

  it('(l) is not resurrected, and does not outlive a cancel from a process that does not hold the run', async () => {
    const world = await open(1);
    const task = await world.holder.bureau.tasks.start('stalling', 'Go.');
    await world.tool.entered(0);
    await world.advanceChecks(3);
    await waitUntil(() => world.peerSeesStalled(task.id));

    // The peer settles the task canceled; its view lists nothing, and the record keeps no stall.
    await world.peer.bureau.internals.taskRegistry.recordSettled(task.id, {
      at: new Date(Date.parse(ORIGIN) + 4 * CHECK_MILLISECONDS).toISOString(),
      status: 'canceled',
      finishReason: 'aborted',
      message: null,
    });
    expect(await world.peerField(task.id, 'status')).toBe('canceled');
    expect(await world.peerField(task.id, 'attention')).toEqual([]);
    expect(await world.peerStoredAttention(task.id)).toBeUndefined();

    // The holder, still silent, goes on to a later check and its own end (a run with no durable
    // workflow cannot be stopped from another process, so its real settlement replaces the peer's):
    // neither writes a stall back.
    await world.advanceChecks(2);
    world.tool.release(0);
    await task.result();
    await world.holder.bureau.internals.taskRegistry.flush();
    expect(await world.peerField(task.id, 'attention')).toEqual([]);
    expect(await world.peerStoredAttention(task.id)).toBeUndefined();
    expect(world.stalled).toHaveLength(1);
  });
});

describe('a run parked on a review (COR-2526)', () => {
  it('(i), AC3: is never stalled, however long it waits past every stall policy', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const world = await openBureau({
      agents: {
        asking: createAgent({
          generate: async () => ({
            content: '',
            toolCalls: [
              { name: 'requestHumanInput', arguments: { signalName: 'ask', prompt: 'Which?' } },
            ],
          }),
          toolbox: createToolbox([]) as unknown as Toolbox,
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
      bureauOptions: { runtime, maintenance: 'manual' },
    });
    opened.push(world);

    const task = await world.bureau.tasks.start('asking', 'Ask.');
    await waitUntil(() => world.bureau.reviews.list().some((review) => review.runId === task.id));
    expect(await fieldOf(world.bureau, task.id, 'status')).toBe('input-required');

    const assessments: string[] = [];
    const subscription = world.bureau.tasks.snapshot(task.id, (snapshot) =>
      assessments.push(snapshot.assessment),
    );

    // Far past three missed pulses of every tool call and every provider turn.
    for (let check = 0; check < 12; check += 1) await runtime.advance(CHECK_MILLISECONDS);
    subscription.unsubscribe();
    // Operative reads a declared wait as one, never as a stall, whatever its watchdogs measured.
    expect(assessments.at(-1)).toBe('legitimately-waiting');
    expect(assessments).not.toContain('alive-but-stalled');
    await world.bureau.internals.taskRegistry.flush();
    expect(await fieldOf(world.bureau, task.id, 'status')).toBe('input-required');
    expect(await fieldOf(world.bureau, task.id, 'attention')).toEqual([]);
    expect(await fieldOf(world.bureau, task.id, 'stalledSince')).toBeNull();
    expect(await listedBy(world.handler, { attention: 'stalled' })).toEqual([]);
  });
});

describe('a run parked on a wakeup (COR-2526)', () => {
  it('(i) is never stalled while it sleeps past every stall policy', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const world = await openBureau({
      agents: {
        sleeper: createAgent({
          generate: async () => ({
            content: '',
            toolCalls: [{ id: 'call-1', name: 'scheduleWakeup', arguments: { in: '6h' } }],
          }),
          toolbox: createToolbox([]) as unknown as Toolbox,
          stopWhen: stopWhen.some(stopWhen.toolCalled('scheduleWakeup'), stopWhen.noToolCalls()),
        }),
      },
      bureauOptions: { runtime, maintenance: 'manual' },
    });
    opened.push(world);

    const task = await world.bureau.tasks.start('sleeper', 'Sleep.');
    await waitUntil(async () => (await fieldOf(world.bureau, task.id, 'wakeAt')) !== null);
    for (let check = 0; check < 12; check += 1) await runtime.advance(CHECK_MILLISECONDS);
    await world.bureau.internals.taskRegistry.flush();

    expect(await fieldOf(world.bureau, task.id, 'status')).toBe('working');
    expect(await fieldOf(world.bureau, task.id, 'wakeAt')).not.toBeNull();
    expect(await fieldOf(world.bureau, task.id, 'attention')).toEqual([]);
    expect(await fieldOf(world.bureau, task.id, 'stalledSince')).toBeNull();
  });
});

describe('a looping run (COR-2526)', () => {
  it('(k), AC4: is looping from the first loop report until it settles, and announced once', async () => {
    const nextTool = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => 'ok',
    });
    const reachedEnd = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const LOOPING_STEPS = 6;
    const toolbox = createToolbox([nextTool], {
      loopDetection: { warningThreshold: 2, blockThreshold: 4, maxWindowSize: 30 },
    }) as unknown as Toolbox;
    const world = await openBureau({
      agents: {
        looper: createAgent({
          generate: async ({ step }: { step: number }) => {
            if (step < LOOPING_STEPS) {
              return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            reachedEnd.resolve();
            await finish.promise;
            return { content: 'Done.', toolCalls: [] };
          },
          toolbox,
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      bureauOptions: { durable: false, maintenance: 'manual' },
    });
    opened.push(world);
    const events: RunLoopingEvent[] = [];
    world.bureau.addEventListener('run.looping', (event) => events.push(event));

    const task = await world.bureau.tasks.start('looper', 'Loop the tool.');
    await reachedEnd.promise;
    await waitUntil(async () => {
      const attention = await fieldOf(world.bureau, task.id, 'attention');
      return attention?.includes('looping') === true;
    });
    expect(await fieldOf(world.bureau, task.id, 'status')).toBe('working');
    expect(await fieldOf(world.bureau, task.id, 'attention')).toEqual(['looping']);
    expect(await fieldOf(world.bureau, task.id, 'stalledSince')).toBeNull();
    expect(await listedBy(world.handler, { attention: 'looping' })).toEqual([
      [task.id, ['looping']],
    ]);

    // Both reports reached the audit trail under their own kinds, and the hook catalog under one.
    for (const type of ['toolbox.loop-warning', 'toolbox.loop-blocked']) {
      const records = await world.bureau.internals.auditTrail!.query({ runId: task.id, type });
      expect(records.length, type).toBeGreaterThan(0);
    }
    // The first report was a warning, and several reports published one event.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: task.id, level: 'warning' });

    finish.resolve();
    await task.result();
    await world.bureau.internals.whenTaskRecorded(task.id);
    await world.bureau.internals.taskRegistry.flush();
    expect(await fieldOf(world.bureau, task.id, 'attention')).toEqual([]);
    expect(events).toHaveLength(1);
  });
});
