/**
 * COR-2527 — one workspace setting, `runs.spendThresholdUsd`, flags any run that costs more. A step
 * judges the run's cost against it; the flag is the task's `attention` kind `overspending`, it stays
 * after the run settles, `run.overspending` is published once, and the run is never stopped. The
 * feed lists the run while it runs and for seven days after it settles.
 *
 * Time is the Bureau's manual runtime; each run takes three scripted steps, the second and third of
 * which wait for the test, so the test reads the task between steps.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { EncryptionKey } from '@lostgradient/cryptography';
import type { BureauAttentionItem } from './attention-feed.ts';
import { RunOverspendingEvent } from './events.ts';
import {
  createReceiver,
  newEncryptionKey,
  SIGNING_SECRET,
  waitForSettledDeliveries,
} from './hooks/hooks.test-support.ts';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support.ts';
import {
  type FileBureauHarness,
  startFileBureau,
} from './testing/agent-file-bureau.test-support.ts';
import { createVendorCatalog } from './testing/vendor-catalog.test-support.ts';

const ORIGIN = '2026-11-19T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const PRINCIPAL = 'api-key:alice';

/** The dollars `claude-opus-5-5` costs per million tokens in and out, from the catalog's own row. */
const PRICING = createVendorCatalog().descriptors.find(
  (row) => row.model === 'claude-opus-5-5',
)!.pricing!;
/** One step's spend: 50,000 tokens in and 10,000 out. */
const STEP = { prompt: 50_000, completion: 10_000, total: 60_000 };
const STEP_COST =
  (STEP.prompt / 1_000_000) * PRICING.inputPerMillionTokens +
  (STEP.completion / 1_000_000) * PRICING.outputPerMillionTokens;
/** Over one step and under two: a run crosses it at its second step. */
const THRESHOLD = STEP_COST * 1.5;
const TOOL_CALL = [{ name: 'lookup-order', arguments: {} }];

let key: EncryptionKey;
beforeAll(async () => {
  key = await newEncryptionKey();
});

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

/**
 * A model that spends one step's cost on each of three steps: the first answers at once, and the
 * second and third wait for the test, so the run is between steps while the test reads it.
 */
function threeSteps() {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const reached = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let generations = 0;
  return {
    reachedSecond: reached[0]!.promise,
    reachedThird: reached[1]!.promise,
    releaseSecond: () => gates[0]!.resolve(),
    releaseThird: () => gates[1]!.resolve(),
    script: async () => {
      generations += 1;
      if (generations === 1) return { content: '', usage: STEP, toolCalls: TOOL_CALL };
      const index = generations - 2;
      reached[index]?.resolve();
      await gates[index]?.promise;
      return generations === 2
        ? { content: '', usage: STEP, toolCalls: TOOL_CALL }
        : { content: 'Done.', usage: STEP };
    },
  };
}

async function start(
  scripts: Record<string, () => unknown>,
  options: {
    readonly threshold?: number;
    readonly model?: string;
    readonly catalog?: ReturnType<typeof createVendorCatalog>['descriptors'];
  } = {},
) {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const receiver = createReceiver();
  const harness = await startFileBureau({
    scripts: scripts as never,
    overrides: {
      runtime,
      maintenance: 'manual',
      durable: false,
      ...(options.catalog === undefined ? {} : { models: { catalog: options.catalog } }),
      answerEncryption: { current: key },
      hooks: {},
      webhooks: { targets: [], fetch: receiver.fetch, sleep: () => Promise.resolve() },
    },
  });
  harnesses.push(harness);
  await harness.put(
    'helper.md',
    agentFileText({ model: options.model ?? KNOWN_MODEL, tools: '[lookup-order]' }),
  );
  await harness.bureau.agents.refresh();
  const { bureau } = harness;
  const overspending: RunOverspendingEvent[] = [];
  bureau.addEventListener('run.overspending', (event) => overspending.push(event));
  const setThreshold = async (value: unknown) => {
    const { revision } = await bureau.settings.get();
    return bureau.settings.update(
      { 'runs.spendThresholdUsd': value },
      { expectedRevision: revision },
    );
  };
  if (options.threshold !== undefined) await setThreshold(options.threshold);
  return { bureau, runtime, receiver, overspending, setThreshold };
}

type Started = Awaited<ReturnType<typeof start>>;

/** A task's `attention` as `bureau.tasks.get` shows it. */
async function attentionOf(world: Started, taskId: string) {
  return (await world.bureau.tasks.get(taskId))?.attention;
}

/** Waits for the run to end and every write the Bureau made for it to land. */
async function settle(world: Started, task: { readonly id: string; result(): Promise<unknown> }) {
  await task.result();
  await world.bureau.internals.whenTaskRecorded(task.id);
  await world.bureau.internals.taskRegistry.flush();
}

/** The overspending items of the Bureau's attention feed. */
async function overspendingItems(world: Started) {
  const { items } = await world.bureau.attention();
  return items.filter((item) => item.kind === 'run-overspending');
}

describe('the spend threshold setting (COR-2527)', () => {
  it('AC1: saves an amount and reads it back, refuses a negative or non-numeric value, and flags nothing while unset', async () => {
    const model = threeSteps();
    const world = await start({ 'claude-opus-5-5': model.script });

    // Nothing is set: no value anywhere, and an expensive run is not flagged.
    const before = await world.bureau.settings.get();
    expect(before.values['runs.spendThresholdUsd']).toBeUndefined();
    expect(before.effective['runs.spendThresholdUsd']).toBeUndefined();
    const task = await world.bureau.tasks.start('helper', 'Go.', { principal: PRINCIPAL });
    model.releaseSecond();
    model.releaseThird();
    await settle(world, task);
    expect((await world.bureau.tasks.get(task.id))?.usage?.costUsd).toBeGreaterThan(THRESHOLD);
    expect(await attentionOf(world, task.id)).toEqual([]);
    expect(await overspendingItems(world)).toEqual([]);
    expect(world.overspending).toEqual([]);

    expect(await world.setThreshold(2.5)).toMatchObject({ outcome: 'applied' });
    expect((await world.bureau.settings.get()).values['runs.spendThresholdUsd']).toBe(2.5);

    for (const refused of [-1, 0, 'five', false, Number.POSITIVE_INFINITY]) {
      expect(await world.setThreshold(refused)).toMatchObject({
        outcome: 'rejected',
        reason: 'invalid-value',
        keys: ['runs.spendThresholdUsd'],
      });
    }
    expect((await world.bureau.settings.get()).values['runs.spendThresholdUsd']).toBe(2.5);
  });
});

describe('a run over the spend threshold (COR-2527)', () => {
  it('AC2, AC3, AC4: is flagged at the step that crosses, stays flagged after it settles, is announced once, and is never stopped', async () => {
    const model = threeSteps();
    const world = await start({ 'claude-opus-5-5': model.script }, { threshold: THRESHOLD });
    const hook = await world.bureau.hooks!.create({
      url: 'https://receiver.example/hook',
      signingSecret: SIGNING_SECRET,
      principal: PRINCIPAL,
      events: ['run.overspending'],
    });
    const task = await world.bureau.tasks.start('helper', 'Go.', { principal: PRINCIPAL });

    // One step in: under the threshold.
    await model.reachedSecond;
    await waitUntil(
      async () => (await world.bureau.tasks.get(task.id))?.usage?.costUsd !== undefined,
    );
    expect(await attentionOf(world, task.id)).toEqual([]);

    // The second step crosses it, and the run goes on.
    model.releaseSecond();
    await model.reachedThird;
    await waitUntil(
      async () => (await attentionOf(world, task.id))?.includes('overspending') === true,
    );
    const running = await world.bureau.tasks.get(task.id);
    expect(running?.status).toBe('working');
    expect(running?.attention).toEqual(['overspending']);

    // The third step is over the threshold too: nothing more is announced, and the run completes.
    model.releaseThird();
    await settle(world, task);
    const settled = await world.bureau.tasks.get(task.id);
    expect(settled?.status).toBe('completed');
    expect(settled?.attention).toEqual(['overspending']);

    expect(world.overspending).toHaveLength(1);
    expect(world.overspending[0]).toMatchObject({ runId: task.id, thresholdUsd: THRESHOLD });
    expect(world.overspending[0]!.costUsd).toBeCloseTo(STEP_COST * 2, 10);
    const deliveries = await waitForSettledDeliveries(world.bureau, hook.id, 1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ kind: 'run.overspending', status: 'delivered' });
    const body = JSON.parse(world.receiver.calls[0]!.body) as { payload: Record<string, unknown> };
    expect(body.payload).toMatchObject({ runId: task.id, thresholdUsd: THRESHOLD });
  });

  it('flags a run whose only step crosses, whichever of the step and the settlement lands first', async () => {
    const world = await start(
      { 'claude-opus-5-5': () => ({ content: 'Done.', usage: STEP }) },
      { threshold: STEP_COST / 2 },
    );
    const task = await world.bureau.tasks.start('helper', 'Go.', { principal: PRINCIPAL });
    await settle(world, task);
    await waitUntil(
      async () => (await attentionOf(world, task.id))?.includes('overspending') === true,
    );

    expect((await world.bureau.tasks.get(task.id))?.status).toBe('completed');
    expect(world.overspending).toHaveLength(1);
  });

  it('a run no step of which was priced is never flagged, however low the threshold', async () => {
    // The catalog row of `gpt-4.1` has no price, so the run's cost is unknown, not zero.
    const world = await start(
      { 'gpt-4.1': () => ({ content: 'Done.', usage: STEP }) },
      {
        threshold: 0.000001,
        model: 'openai/gpt-4.1',
        catalog: createVendorCatalog().descriptors.map((row) =>
          row.model === 'gpt-4.1' ? { ...row, pricing: undefined } : row,
        ),
      },
    );
    const task = await world.bureau.tasks.start('helper', 'Go.', { principal: PRINCIPAL });
    await settle(world, task);

    expect((await world.bureau.tasks.get(task.id))?.usage?.costUsd).toBeNull();
    expect(await attentionOf(world, task.id)).toEqual([]);
    expect(world.overspending).toEqual([]);
  });

  it('AC7: a changed threshold applies only to later steps', async () => {
    // A run that settled under a high threshold stays unflagged when the threshold is lowered.
    const first = threeSteps();
    const world = await start({ 'claude-opus-5-5': first.script }, { threshold: 100 });
    const settledRun = await world.bureau.tasks.start('helper', 'Go.', { principal: PRINCIPAL });
    first.releaseSecond();
    first.releaseThird();
    await settle(world, settledRun);
    expect(await world.setThreshold(STEP_COST / 2)).toMatchObject({ outcome: 'applied' });
    await world.bureau.internals.taskRegistry.flush();
    expect(await attentionOf(world, settledRun.id)).toEqual([]);
    expect(await overspendingItems(world)).toEqual([]);
    expect(world.overspending).toEqual([]);
  });

  it('AC7: a flag stays when the threshold is raised after it, and is written once', async () => {
    const model = threeSteps();
    const world = await start({ 'claude-opus-5-5': model.script }, { threshold: THRESHOLD });
    const task = await world.bureau.tasks.start('helper', 'Go.', { principal: PRINCIPAL });
    await model.reachedSecond;
    model.releaseSecond();
    await model.reachedThird;
    await waitUntil(
      async () => (await attentionOf(world, task.id))?.includes('overspending') === true,
    );

    expect(await world.setThreshold(1000)).toMatchObject({ outcome: 'applied' });
    model.releaseThird();
    await settle(world, task);

    expect(await attentionOf(world, task.id)).toEqual(['overspending']);
    const record = await world.bureau.internals.taskRegistry.record(task.id);
    expect(record?.overspending?.thresholdUsd).toBe(THRESHOLD);
    expect(world.overspending).toHaveLength(1);
  });
});

describe('the attention feed lists a run over the threshold (COR-2527)', () => {
  it('AC6: lists it while it runs and for seven days after it settles, while the task keeps `overspending`', async () => {
    const model = threeSteps();
    const world = await start({ 'claude-opus-5-5': model.script }, { threshold: THRESHOLD });
    const task = await world.bureau.tasks.start('helper', 'Go.', { principal: PRINCIPAL });
    await model.reachedSecond;
    model.releaseSecond();
    await model.reachedThird;
    await waitUntil(async () => (await overspendingItems(world)).length === 1);

    const [whileRunning] = (await overspendingItems(world)) as Extract<
      BureauAttentionItem,
      { kind: 'run-overspending' }
    >[];
    expect(whileRunning).toMatchObject({
      kind: 'run-overspending',
      area: 'runs',
      runId: task.id,
      agentName: 'helper',
      thresholdUsd: THRESHOLD,
      settledAt: null,
    });

    model.releaseThird();
    await settle(world, task);
    await world.runtime.advance(7 * DAY - 1_000);
    const [afterSettling] = (await overspendingItems(world)) as Extract<
      BureauAttentionItem,
      { kind: 'run-overspending' }
    >[];
    expect(afterSettling).toMatchObject({ runId: task.id });
    expect(afterSettling!.settledAt).not.toBeNull();
    expect(afterSettling!.costUsd).toBeCloseTo(STEP_COST * 3, 10);

    await world.runtime.advance(DAY + 2_000);
    expect(await overspendingItems(world)).toEqual([]);
    expect(await attentionOf(world, task.id)).toEqual(['overspending']);
  });
});
