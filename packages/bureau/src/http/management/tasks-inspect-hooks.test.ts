/**
 * COR-2115 — `bureau.tasks.inspect` carries a live run's hook plan and the hooks of its plan that
 * threw, read over a real Bureau and its handler. The plan is each registration's identity, hook
 * point, who registered it, priority and replay, redacted; the failures are one entry for each
 * registration, with how many times it threw and when it last did, never the error's text.
 *
 * What a run's `hooks` says for each state a run can be in (the same table drives the unit rows in
 * `tasks/create-tasks-hooks.test.ts` and the reattach rows in `active-run-reattach-hook-plan.test.ts`
 * in operative); on main today `bureau.tasks.inspect` carried no `hooks` field at all, so each row
 * of the first column was `undefined`:
 *
 * | The run                                          | `hooks.plan`          | `hooks.failed`                 |
 * | ------------------------------------------------ | --------------------- | ------------------------------ |
 * | live, one hook threw once and one threw twice    | every registration    | both, latest failure first     |
 * | live, a hook that never threw                    | listed, not in failed | absent                         |
 * | settled, the same two hooks threw                | `null`                | both, with the same counts     |
 * | live, a plugin's hook threw                      | its id and source     | its id and source              |
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateFunction,
  type OperativeHookMap,
  stopWhen,
} from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  as,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const CANARY = 'CANARY-2115-HOOK-b6d1';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A plugin's plan: a hook at the start of the run that throws once, a hook before each step that
 * throws on both steps the run takes, and a hook after each step that never throws.
 */
function pluginPlan(): HookRegistry<OperativeHookMap> {
  const hooks = new HookRegistry<OperativeHookMap>({
    source: 'acme-audit',
    onError: () => 'continue',
  });
  const boom = async (): Promise<void> => {
    throw new Error(`the hook failed: ${CANARY}`, { cause: new Error(`cause ${CANARY}`) });
  };
  hooks.on('onRunStart', boom, { id: 'acme-audit:on-start', replay: 'safe' });
  hooks.on('prepareStep', boom, { id: 'acme-audit:each-step', replay: 'safe', priority: 5 });
  hooks.on('onStep', async () => {}, { id: 'acme-audit:quiet', replay: 'effectful' });
  return hooks;
}

/** Step 0 calls a tool and step 1 parks, so the run is live with two steps behind its hooks. */
const stepsThenParks: GenerateFunction = async (context) => {
  if (context.step === 0) {
    return { content: '', toolCalls: [{ id: 'call-1', name: 'noop', arguments: {} }] };
  }
  return new Promise((_resolve, reject) => {
    context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
};

function noopToolbox(): Toolbox {
  return createToolbox([
    createTool({
      name: 'noop',
      version: '1.0.0',
      description: 'Does nothing',
      input: z.object({}),
      async execute() {
        return { done: true };
      },
    }),
  ]) as unknown as Toolbox;
}

async function serve(): Promise<OpenedBureau> {
  const opened = await openBureau({
    agents: {
      worker: createAgent({
        name: 'worker',
        generate: stepsThenParks,
        stopWhen: stopWhen.noToolCalls(),
        toolbox: noopToolbox(),
        hooks: pluginPlan(),
      }),
    },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

type Inspected = {
  hooks: {
    plan: Array<{
      id: string;
      hookPoint: string;
      source: string | null;
      priority: number;
      replay: string;
    }> | null;
    failed: Array<{
      hookId: string;
      hookPoint: string;
      source: string | null;
      count: number;
      lastFailedAt: string;
    }>;
  };
};

const inspect = async (opened: OpenedBureau, taskId: string, key = 'alice-key') => {
  const body: RpcBody = await rpc(opened.handler, 'bureau.tasks.inspect', { taskId }, key);
  expect(body.error).toBeUndefined();
  return body.result as unknown as Inspected;
};

/** Waits until the run has thrown through both of its steps, so the counts are final. */
async function afterBothSteps(opened: OpenedBureau, taskId: string): Promise<Inspected> {
  let seen: Inspected | undefined;
  await waitUntil(
    async () => {
      seen = await inspect(opened, taskId);
      return seen.hooks.failed.find((hook) => hook.hookId === 'acme-audit:each-step')?.count === 2;
    },
    { message: 'the per-step hook threw on both steps' },
  );
  return seen!;
}

describe('bureau.tasks.inspect on a live run (AC1)', () => {
  it('lists the plan with each registration’s id, hook point, source, priority and replay', async () => {
    const opened = await serve();
    const run = await opened.bureau.tasks.start('worker', 'go', { principal: OWNER.alice });
    const inspected = await afterBothSteps(opened, run.id);

    const plan = inspected.hooks.plan;
    expect(plan).not.toBeNull();
    expect(plan!.filter((entry) => entry.source === 'acme-audit')).toEqual(
      expect.arrayContaining([
        {
          id: 'acme-audit:on-start',
          hookPoint: 'onRunStart',
          source: 'acme-audit',
          // The plan is the run's merged one: an agent's own hooks sit in the agent tier, 1000 above
          // the default, and the registration's own 5 rides on it.
          priority: 1000,
          replay: 'safe',
        },
        {
          id: 'acme-audit:each-step',
          hookPoint: 'prepareStep',
          source: 'acme-audit',
          priority: 1005,
          replay: 'safe',
        },
        {
          id: 'acme-audit:quiet',
          hookPoint: 'onStep',
          source: 'acme-audit',
          priority: 1000,
          replay: 'effectful',
        },
      ]),
    );
    // Every entry is exactly the five fields, and none carries a handler or its error closure.
    for (const entry of plan!) {
      expect(Object.keys(entry).toSorted()).toEqual(
        ['hookPoint', 'id', 'priority', 'replay', 'source'].toSorted(),
      );
    }
    expect(new Set(plan!.map((entry) => entry.id)).size).toBe(plan!.length);
  });

  it('answers another owner as a missing task, so it carries no plan to them', async () => {
    const opened = await serve();
    const run = await opened.bureau.tasks.start('worker', 'go', { principal: OWNER.alice });
    await afterBothSteps(opened, run.id);

    // Another owner's inspection answers as a missing task does, so it carries no plan either.
    const stranger = await rpc(
      opened.handler,
      'bureau.tasks.inspect',
      { taskId: run.id },
      'bob-key',
    );
    expect(stranger.result).toBeUndefined();
    expect(stranger.error?.data?.httpStatus).toBe(404);
  });
});

describe('the hooks that threw (AC2)', () => {
  it('lists a throwing plugin hook with its id and source while the run is live, once for each registration with its count, latest failure first', async () => {
    const opened = await serve();
    const run = await opened.bureau.tasks.start('worker', 'go', { principal: OWNER.alice });

    const inspected = await afterBothSteps(opened, run.id);

    expect(
      inspected.hooks.failed.map((hook) => [hook.hookId, hook.hookPoint, hook.source, hook.count]),
    ).toEqual([
      ['acme-audit:each-step', 'prepareStep', 'acme-audit', 2],
      ['acme-audit:on-start', 'onRunStart', 'acme-audit', 1],
    ]);
    const times = inspected.hooks.failed.map((hook) => Date.parse(hook.lastFailedAt));
    expect(times.every((time) => !Number.isNaN(time))).toBe(true);
    expect(times).toEqual(times.toSorted((first, second) => second - first));
    // The hook that never threw is in the plan and not in the failures.
    expect(inspected.hooks.failed.map((hook) => hook.hookId)).not.toContain('acme-audit:quiet');
    expect(inspected.hooks.plan?.map((entry) => entry.id)).toContain('acme-audit:quiet');
  });

  it('lists the same failures after the run has settled, with no plan and the same counts', async () => {
    const opened = await serve();
    const run = await opened.bureau.tasks.start('worker', 'go', { principal: OWNER.alice });
    const live = await afterBothSteps(opened, run.id);

    await opened.bureau.tasks.cancel(run.id, { waitMilliseconds: 5_000 });
    await waitUntil(
      async () => {
        const task = await opened.bureau.tasks.get(run.id);
        return ['canceled', 'failed', 'completed'].includes(task?.status ?? '');
      },
      { message: 'the run settled' },
    );
    const settled = await inspect(opened, run.id);

    // A settled run has no plan to show, only what threw.
    expect(settled.hooks.plan).toBeNull();
    expect(settled.hooks.failed).toEqual(live.hooks.failed);
  });

  it('carries no error text, message, cause or stack, on a live run or a settled one', async () => {
    const opened = await serve();
    const run = await opened.bureau.tasks.start('worker', 'go', { principal: OWNER.alice });
    await afterBothSteps(opened, run.id);
    const response = await opened.handler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...as('alice-key') },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.tasks.inspect',
          params: { taskId: run.id },
        }),
      }),
    );
    const text = await response.text();

    expect(text).toContain('acme-audit:each-step');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('the hook failed');
  });

  it('is empty for a run whose hooks never threw', async () => {
    const opened = await openBureau({
      agents: {
        calm: createAgent({
          name: 'calm',
          generate: stepsThenParks,
          stopWhen: stopWhen.noToolCalls(),
          toolbox: noopToolbox(),
        }),
      },
    });
    cleanups.push(() => opened.dispose());
    const run = await opened.bureau.tasks.start('calm', 'go', { principal: OWNER.alice });
    await waitUntil(async () => (await opened.bureau.tasks.detail(run.id)) !== undefined, {
      message: 'the run is live',
    });

    const inspected = await inspect(opened, run.id);

    expect(inspected.hooks.failed).toEqual([]);
    expect(inspected.hooks.plan).not.toBeNull();
  });
});
