/**
 * COR-2524 — a run's cost is recorded on its task, whether or not its agent declares a budget.
 * Each row of the outcome matrix is a run that ends (or is read) a different way: the figure is the
 * run's own priced estimate, `null` when nothing was priced, and never a silent `0`.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { TaskUsage } from './task-registry.ts';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support.ts';
import {
  type FileBureauHarness,
  startFileBureau,
} from './testing/agent-file-bureau.test-support.ts';
import { createVendorCatalog } from './testing/vendor-catalog.test-support.ts';

/** The dollars `claude-opus-5-5` costs per million tokens in and out, from the catalog's own row. */
const PRICING = createVendorCatalog().descriptors.find(
  (row) => row.model === 'claude-opus-5-5',
)!.pricing!;
const dollars = (prompt: number, completion: number): number =>
  (prompt / 1_000_000) * PRICING.inputPerMillionTokens +
  (completion / 1_000_000) * PRICING.outputPerMillionTokens;

/** One step's spend: 50,000 tokens in and 10,000 out. */
const STEP = { prompt: 50_000, completion: 10_000, total: 60_000 };
const STEP_COST = dollars(STEP.prompt, STEP.completion);
const TOOL_CALL = [{ name: 'lookup-order', arguments: {} }];

/** The catalog with `gpt-4.1` left without a price; every other row keeps its own. */
const CATALOG_WITHOUT_GPT_PRICE = createVendorCatalog().descriptors.map((row) =>
  row.model === 'gpt-4.1' ? { ...row, pricing: undefined } : row,
);

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

type Script = () => unknown;

/** A model that spends on its first step, asks for a tool, and holds its second step. */
function heldSecondStep() {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let generations = 0;
  const script: Script = async () => {
    generations += 1;
    if (generations === 1) return { content: '', usage: STEP, toolCalls: TOOL_CALL };
    reached.resolve();
    await gate.promise;
    return { content: 'late', usage: STEP };
  };
  return { reached: reached.promise, release: gate.resolve, script };
}

async function start(
  dispatch: 'non-durable' | 'durable',
  frontmatter: Record<string, string>,
  scripts: Record<string, Script>,
  catalog?: typeof CATALOG_WITHOUT_GPT_PRICE,
) {
  const harness = await startFileBureau({
    scripts: scripts as never,
    overrides: {
      durable: dispatch === 'durable',
      ...(catalog === undefined ? {} : { models: { catalog } }),
    },
  });
  harnesses.push(harness);
  await harness.put('helper.md', agentFileText(frontmatter));
  await harness.bureau.agents.refresh();
  return harness.bureau;
}

/** The task's record once its run has ended and everything the Bureau wrote for it has landed. */
async function settledTask(bureau: FileBureauHarness['bureau'], taskId: string) {
  await bureau.internals.whenTaskRecorded(taskId);
  await bureau.internals.taskRegistry.flush();
  const view = await bureau.tasks.get(taskId);
  expect(view).toBeDefined();
  return view!;
}

function expectUsage(usage: TaskUsage | null, expected: { tokens: typeof STEP; costUsd: number }) {
  expect(usage).not.toBeNull();
  expect(usage!.promptTokens).toBe(expected.tokens.prompt);
  expect(usage!.completionTokens).toBe(expected.tokens.completion);
  expect(usage!.totalTokens).toBe(expected.tokens.total);
  expect(usage!.costUsd).toBeCloseTo(expected.costUsd, 10);
}

describe.each(['non-durable', 'durable'] as const)('a task’s cost, %s dispatch', (dispatch) => {
  const priced = (script: Script) => ({ 'claude-opus-5-5': script });

  it('(a) records the cost of a run that settles normally, for an agent with no limits.cost', async () => {
    const bureau = await start(
      dispatch,
      { model: KNOWN_MODEL },
      priced(() => ({
        content: 'Done.',
        usage: STEP,
      })),
    );
    const task = await bureau.tasks.start('helper', 'Go.');
    await task.result();

    const view = await settledTask(bureau, task.id);
    expect(view.status).toBe('completed');
    expectUsage(view.usage, { tokens: STEP, costUsd: STEP_COST });
    // `list` reads the same record.
    const listed = await bureau.internals.taskRegistry.list({
      principal: view.owner,
      owner: view.owner,
      limit: 10,
    });
    expectUsage(listed.tasks.find((entry) => entry.id === task.id)!.usage, {
      tokens: STEP,
      costUsd: STEP_COST,
    });
  });

  it('(b) records the cost so far of a run that fails', async () => {
    let generations = 0;
    const bureau = await start(
      dispatch,
      { model: KNOWN_MODEL, tools: '[lookup-order]' },
      priced(() => {
        generations += 1;
        if (generations === 1) return { content: '', usage: STEP, toolCalls: TOOL_CALL };
        throw new Error('The provider failed.');
      }),
    );
    const task = await bureau.tasks.start('helper', 'Go.');
    await task.result();

    const view = await settledTask(bureau, task.id);
    expect(view.status).toBe('failed');
    expectUsage(view.usage, { tokens: STEP, costUsd: STEP_COST });
  });

  it('(c) records the cost of the steps a cancelled run completed', async () => {
    const model = heldSecondStep();
    const bureau = await start(
      dispatch,
      { model: KNOWN_MODEL, tools: '[lookup-order]' },
      priced(model.script),
    );
    const task = await bureau.tasks.start('helper', 'Go.');
    await model.reached;
    await bureau.tasks.cancel(task.id);
    model.release();
    await task.result();

    const view = await settledTask(bureau, task.id);
    expect(view.status).toBe('canceled');
    expectUsage(view.usage, { tokens: STEP, costUsd: STEP_COST });
  });

  it('AC6: the record holds the cost so far between two steps', async () => {
    const model = heldSecondStep();
    const bureau = await start(
      dispatch,
      { model: KNOWN_MODEL, tools: '[lookup-order]' },
      priced(model.script),
    );
    const task = await bureau.tasks.start('helper', 'Go.');
    await model.reached;
    await waitUntil(async () => {
      const view = await bureau.tasks.get(task.id);
      return view?.usage?.costUsd !== undefined;
    });

    const running = await bureau.tasks.get(task.id);
    expect(running?.status).toBe('working');
    expectUsage(running?.usage ?? null, { tokens: STEP, costUsd: STEP_COST });

    model.release();
    await task.result();
    // The second step doubles it, and the settlement's own total is the figure the record ends on.
    const settled = await settledTask(bureau, task.id);
    expect(settled.usage?.costUsd).toBeCloseTo(STEP_COST * 2, 10);
    expect(settled.usage?.totalTokens).toBe(STEP.total * 2);
  });

  it('(e) says the cost is unknown, not zero, for a model with no catalog price', async () => {
    const bureau = await start(
      dispatch,
      { model: 'openai/gpt-4.1' },
      { 'gpt-4.1': () => ({ content: 'Done.', usage: STEP }) },
      CATALOG_WITHOUT_GPT_PRICE,
    );
    const task = await bureau.tasks.start('helper', 'Go.');
    await task.result();

    const view = await settledTask(bureau, task.id);
    expect(view.status).toBe('completed');
    expect(view.usage).toEqual({
      promptTokens: STEP.prompt,
      completionTokens: STEP.completion,
      totalTokens: STEP.total,
      costUsd: null,
    });
  });

  it('keeps a budgeted agent’s cost the same, and the budget still stops it', async () => {
    const bureau = await start(
      dispatch,
      { model: KNOWN_MODEL, limits: '{ cost: { run: 0.01 } }' },
      priced(() => ({ content: 'Done.', usage: STEP })),
    );
    const task = await bureau.tasks.start('helper', 'Go.');
    const result = await task.result();

    expect(result.finishReason).toBe('budget-exceeded');
    const view = await settledTask(bureau, task.id);
    expectUsage(view.usage, { tokens: STEP, costUsd: STEP_COST });
  });
});
