/**
 * COR-1921 — a cost budget is never silently bypassed by switching to a model with no catalog
 * price. A steer to such a model is refused with a reason that names the field and the budget; a
 * step that still reaches one (the agent's file gained a budget after the switch, or a fork
 * carries a model whose price has gone) stops the run as `budget-exceeded` naming the model, or
 * answers the carry as rejected. An agent with no budget switches freely, and a priced model is
 * always allowed.
 */
import { createModelCatalog } from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureauHandler } from './http/create-bureau-handler';
import { authentication, OWNER, rpc } from './http/management/management-fixtures.test-support';
import { waitForTaskState } from './test';
import { startTaskFrom } from './test/task-start-request.ts';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

const OPUS_5 = { provider: 'anthropic', model: 'claude-opus-5' } as const;
const GPT_4_1 = { provider: 'openai', model: 'gpt-4.1' } as const;

/** The default catalog with `gpt-4.1` left without a price; every other row keeps its own. */
const CATALOG = createModelCatalog().descriptors.map((row) =>
  row.model === 'gpt-4.1' ? { ...row, pricing: undefined } : row,
);

const BUDGETED = agentFileText({
  model: KNOWN_MODEL,
  tools: '[lookup-order]',
  costBudget: '{ perRunUsd: 5 }',
});
const UNBUDGETED = agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]' });

/** `claude-opus-5` served by an unpriced `twin` provider ahead of the priced `anthropic` row. */
const TWIN_CATALOG = [
  {
    ...createModelCatalog().descriptors.find((row) => row.model === 'claude-opus-5')!,
    provider: 'twin',
    pricing: undefined,
  },
  ...CATALOG,
];
const TWIN = { provider: 'twin', model: 'claude-opus-5' } as const;

async function start(
  file: string,
  options: {
    readonly catalog?: typeof CATALOG;
    readonly durable?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const harness = await startFileBureau({
    scripts: {
      'claude-opus-5-5': () => (calls.push('claude-opus-5-5'), 'done'),
      'claude-opus-5': () => (calls.push('claude-opus-5'), 'done'),
      'gpt-4.1': () => (calls.push('gpt-4.1'), 'done'),
    },
    overrides: {
      id: 'unpriced-switch-bureau',
      models: { catalog: options.catalog ?? CATALOG },
      ...(options.durable === undefined ? {} : { durable: options.durable }),
    },
  });
  harnesses.push(harness);
  await harness.put('picker.md', file);
  await harness.bureau.agents.refresh();
  return { harness, calls };
}

async function runPicker(harness: FileBureauHarness, sessionId?: string) {
  const run = await startTaskFrom(harness.bureau, {
    input: 'go',
    agentName: 'picker',
    principal: OWNER.alice,
    ...(sessionId === undefined ? {} : { contextId: sessionId }),
  });
  await waitForTaskState(harness.bureau, run.id);
  return run;
}

const steer = (
  harness: FileBureauHarness,
  sessionId: string,
  id: string,
  choice: { provider: string; model: string },
) =>
  harness.bureau.contexts.steer(sessionId, {
    id,
    principal: OWNER.alice,
    requestedValue: { target: 'model', override: choice.model, provider: choice.provider } as never,
  });

describe('a steer to a model with no price', () => {
  it('is refused for an agent with a cost budget, naming the budget and the model, and changes nothing', async () => {
    const { harness } = await start(BUDGETED);
    const first = await runPicker(harness);

    const error = await rejectionOf(steer(harness, first.contextId, 'switch', GPT_4_1));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('costBudget');
    expect((error as Error).message).toContain('gpt-4.1');
    expect(await harness.bureau.contexts.steering(first.contextId)).toMatchObject({ model: null });
  });

  it('is refused the same way when the caller names no provider', async () => {
    const { harness } = await start(BUDGETED);
    const first = await runPicker(harness);

    const error = await rejectionOf(
      harness.bureau.contexts.steer(first.contextId, {
        id: 'switch',
        principal: OWNER.alice,
        requestedValue: { target: 'model', override: 'gpt-4.1' },
      }),
    );

    expect((error as Error).message).toContain('costBudget');
  });

  it('answers bureau.contexts.steer InvalidParams naming the override field and the budget', async () => {
    const { harness } = await start(BUDGETED);
    const first = await runPicker(harness);
    const handler = createBureauHandler(harness.bureau, { authentication });

    const body = await rpc(
      handler,
      'bureau.contexts.steer',
      { contextId: first.contextId, commandId: 'switch', override: GPT_4_1 },
      'alice-key',
    );

    expect(body.error?.data?.['weftCode']).toBe('InvalidParams');
    expect(body.error?.data?.['issues']).toEqual([
      expect.objectContaining({
        path: ['override'],
        message: expect.stringContaining('costBudget'),
      }),
    ]);
  });

  it('is allowed when the model has a price', async () => {
    const { harness, calls } = await start(BUDGETED);
    const first = await runPicker(harness);

    const outcome = await steer(harness, first.contextId, 'switch', OPUS_5);
    await runPicker(harness, first.contextId);

    expect(outcome.outcome).toBe('accepted');
    expect(calls).toEqual(['claude-opus-5-5', 'claude-opus-5']);
  });

  it('is allowed for an agent with no cost budget', async () => {
    const { harness, calls } = await start(UNBUDGETED);
    const first = await runPicker(harness);

    const outcome = await steer(harness, first.contextId, 'switch', GPT_4_1);
    const second = await runPicker(harness, first.contextId);

    expect(outcome.outcome).toBe('accepted');
    expect(calls).toEqual(['claude-opus-5-5', 'gpt-4.1']);
    expect(harness.bureau.tasks.detail(second.id)?.status).not.toBe('error');
  });
});

describe('a run that still reaches a model with no price under a budget', () => {
  it('stops with budget-exceeded naming the model, and never asks the model', async () => {
    const { harness, calls } = await start(UNBUDGETED);
    const first = await runPicker(harness);
    const switched = await steer(harness, first.contextId, 'switch', GPT_4_1);
    expect(switched.outcome).toBe('accepted');

    // The file gains a budget after the switch, so the session's model is now one it cannot count.
    await harness.put('picker.md', BUDGETED);
    await harness.bureau.agents.refresh();
    const second = await runPicker(harness, first.contextId);

    const summary = harness.bureau.tasks.detail(second.id);
    expect(summary?.status).toBe('error');
    expect(summary?.error).toContain('gpt-4.1');
    expect(summary?.error).toContain('perRunUsd');
    expect(calls).toEqual(['claude-opus-5-5']);
  });
});

describe('a fork that carries a model with no price under a budget', () => {
  it('answers the carry as rejected and still makes the fork', async () => {
    const { harness } = await start(UNBUDGETED);
    const first = await runPicker(harness);
    const switched = await steer(harness, first.contextId, 'switch', GPT_4_1);
    expect(switched.outcome).toBe('accepted');
    await harness.put('picker.md', BUDGETED);
    await harness.bureau.agents.refresh();

    const forked = await harness.bureau.contexts.fork(first.contextId, {
      owner: OWNER.alice,
      commandId: 'fork-1',
      throughMessageId: null,
    });

    expect(forked.carriedOverride).toMatchObject({
      outcome: 'rejected',
      failure: { reason: 'policy-denied' },
    });
    expect(await harness.bureau.contexts.steering(forked.contextId)).toMatchObject({ model: null });
  });
});

describe('a model that two providers serve, one of them without a price (COR-1921)', () => {
  it('refuses a switch that names no provider, which runs the unpriced first row', async () => {
    const { harness } = await start(BUDGETED, { catalog: TWIN_CATALOG });
    const first = await runPicker(harness);

    const error = await rejectionOf(
      harness.bureau.contexts.steer(first.contextId, {
        id: 'switch',
        principal: OWNER.alice,
        requestedValue: { target: 'model', override: 'claude-opus-5' },
      }),
    );

    expect((error as Error).message).toContain('costBudget');
    expect((error as Error).message).toContain('twin');
    expect(await harness.bureau.contexts.steering(first.contextId)).toMatchObject({ model: null });
  });

  it('refuses the unpriced provider and admits the priced one, which then runs', async () => {
    const { harness, calls } = await start(BUDGETED, { catalog: TWIN_CATALOG });
    const first = await runPicker(harness);

    const refused = await rejectionOf(steer(harness, first.contextId, 'twin', TWIN));
    const admitted = await steer(harness, first.contextId, 'priced', OPUS_5);
    const second = await runPicker(harness, first.contextId);

    expect((refused as Error).message).toContain('costBudget');
    expect(admitted.outcome).toBe('accepted');
    expect(harness.bureau.tasks.detail(second.id)?.status).not.toBe('error');
    expect(calls).toEqual(['claude-opus-5-5', 'claude-opus-5']);
  });

  it('stops a run switched, before the budget, with no provider, and not one that named the priced provider', async () => {
    const { harness, calls } = await start(UNBUDGETED, { catalog: TWIN_CATALOG });
    const bare = await runPicker(harness);
    const named = await runPicker(harness);
    const bareSwitch = await harness.bureau.contexts.steer(bare.contextId, {
      id: 'bare',
      principal: OWNER.alice,
      requestedValue: { target: 'model', override: 'claude-opus-5' },
    });
    const namedSwitch = await steer(harness, named.contextId, 'named', OPUS_5);
    expect([bareSwitch.outcome, namedSwitch.outcome]).toEqual(['accepted', 'accepted']);
    await harness.put('picker.md', BUDGETED);
    await harness.bureau.agents.refresh();
    calls.length = 0;

    const stopped = await runPicker(harness, bare.contextId);
    const running = await runPicker(harness, named.contextId);

    expect(harness.bureau.tasks.detail(stopped.id)?.error).toContain('claude-opus-5');
    expect(harness.bureau.tasks.detail(running.id)?.status).not.toBe('error');
    expect(calls).toEqual(['claude-opus-5']);
  });
});

describe('retrying a switch that was admitted (COR-1921)', () => {
  it.each([true, false])(
    'is answered as a replay, even after the catalog loses the model’s price (durable: %s)',
    async (durable) => {
      const { harness } = await start(BUDGETED, { durable });
      const first = await runPicker(harness);
      const admitted = await steer(harness, first.contextId, 'switch', OPUS_5);
      expect(admitted.outcome).toBe('accepted');

      harness.bureau.models.replace(
        CATALOG.map((row) =>
          row.model === 'claude-opus-5' ? { ...row, pricing: undefined } : row,
        ),
      );
      const retried = await steer(harness, first.contextId, 'switch', OPUS_5);
      const fresh = await rejectionOf(steer(harness, first.contextId, 'another', OPUS_5));

      expect(retried.outcome).toBe('replayed');
      expect((fresh as Error).message).toContain('costBudget');
    },
  );
});

describe('which models a budgeted agent lists', () => {
  it('marks a model with no price as unpriced, and marks none for an agent with no budget', async () => {
    const budgeted = await start(BUDGETED);
    const unbudgeted = await start(UNBUDGETED);

    const marked = budgeted.harness.bureau.agents.models('picker');
    const plain = unbudgeted.harness.bureau.agents.models('picker');

    expect(marked?.models.find((choice) => choice.model === 'gpt-4.1')).toMatchObject({
      unpriced: true,
    });
    expect(
      marked?.models.find((choice) => choice.model === 'claude-opus-5')?.unpriced,
    ).toBeUndefined();
    expect(plain?.models.some((choice) => choice.unpriced === true)).toBe(false);
  });
});

describe('an agent that is tried and not saved', () => {
  const DEFINITION = {
    name: 'Sketch',
    model: KNOWN_MODEL,
    tools: ['lookup-order'],
    costBudget: { perRunUsd: 5 },
    instructions: 'You are a sketch of an agent.\n',
  };

  it('has its budget enforced: a switch to an unpriced model is refused, and a run that still reaches one stops', async () => {
    const { harness, calls } = await start(UNBUDGETED);
    const tried = await harness.bureau.agents.try(DEFINITION, 'hello', { principal: OWNER.alice });
    await waitForTaskState(harness.bureau, tried.taskId);

    const refused = await rejectionOf(steer(harness, tried.contextId, 'switch', GPT_4_1));
    expect((refused as Error).message).toContain('costBudget');

    // The catalog gains a price afterwards, so the switch is admitted; the agent was built before
    // that, and still cannot count the model.
    harness.bureau.models.replace(createModelCatalog().descriptors);
    const admitted = await steer(harness, tried.contextId, 'switch-again', GPT_4_1);
    expect(admitted.outcome).toBe('accepted');
    calls.length = 0;
    const task = await harness.bureau.tasks.start(tried.agentName, 'again', {
      contextId: tried.contextId,
      principal: OWNER.alice,
    });
    await waitForTaskState(harness.bureau, task.id);

    const summary = harness.bureau.tasks.detail(task.id);
    expect(summary?.status).toBe('error');
    expect(summary?.error).toContain('gpt-4.1');
    expect(summary?.error).toContain('perRunUsd');
    expect(calls).toEqual([]);
  });
});
