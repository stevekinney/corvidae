import {
  stopWhen,
  waitForCondition,
  createAgent,
  type GenerateFunction,
} from '@lostgradient/operative';
import { MemoryStorage, type BatchOperation } from '@lostgradient/weft';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import type { Bureau, BureauOptions } from './types';
import type { AgentDefinitions } from './agent-catalog';
import { listHeldTasks } from './test';

/**
 * COR-1627: a run that stops at its step limit is a failure on every Bureau surface. Its run
 * record, its session, its task, its audit trail, and its report all read the failure, and the
 * `run.error` it now fires is counted once by each of them.
 */

const bureaus: Bureau[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const nextTool = createTool({
  name: 'next',
  description: 'Asks for one more step',
  input: z.object({}),
  execute: async () => 'ok',
});

/** A Bureau whose model never stops, so every run ends at its second step. */
async function openStepLimitBureau(options: Partial<BureauOptions>): Promise<Bureau> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async () => ({
          content: 'still going',
          toolCalls: [{ name: 'next', arguments: {} }],
        }),
        toolbox: createToolbox([nextTool]),
        maximumSteps: 2,
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    ...options,
  });
  bureaus.push(bureau);
  return bureau;
}

/** Starts a run and waits for the session to record how it ended. */
async function runToLimit(bureau: Bureau) {
  const run = await bureau.tasks.start('default', 'Never settles', { principal: 'alice' });
  await waitForCondition(async () => {
    const session = await bureau.contexts.get(run.contextId);
    return session?.metadata['lastRunStatus'] === 'error';
  }, 'the session never recorded how the run ended');
  return run;
}

/** The in-process loop and the durable workflow both end a run at its step limit. */
const EXECUTIONS: readonly (readonly [string, Partial<BureauOptions>])[] = [
  ['in process', { storage: { type: 'memory' }, durable: false }],
  ['durably', { storage: { type: 'memory' }, durable: true }],
];

describe.each(EXECUTIONS)('a run that stops at its step limit, %s (COR-1627)', (_name, options) => {
  it('reads error in the run record, listRuns, and getRun', async () => {
    const bureau = await openStepLimitBureau(options);

    const run = await runToLimit(bureau);

    const detail = bureau.tasks.detail(run.id);
    expect(detail?.status).toBe('error');
    expect(detail?.finishReason).toBe('maximum-steps');
    expect(listHeldTasks(bureau)[0]?.status).toBe('error');
    expect(listHeldTasks(bureau)[0]?.id).toBe(run.id);
  });

  it('reads error in the session’s last run, with the step-limit error', async () => {
    const bureau = await openStepLimitBureau(options);

    const run = await runToLimit(bureau);

    const session = await bureau.contexts.get(run.contextId);
    expect(session?.metadata['lastRunStatus']).toBe('error');
    expect(session?.metadata['lastFinishReason']).toBe('maximum-steps');
    expect(session?.metadata['lastError']).toContain('Agent run exceeded maximumSteps (2).');
  });

  it('settles its task as failed with the step-limit error, and records one run.error in the audit trail', async () => {
    const bureau = await openStepLimitBureau(options);
    const run = await bureau.tasks.start('default', 'Never settles', { principal: 'alice' });
    await waitForCondition(async () => {
      const task = await bureau.internals.taskRegistry.get(run.id);
      return task?.status === 'failed';
    }, 'the task never settled as failed');
    await waitForCondition(async () => {
      const records = (await bureau.internals.auditTrail?.query({ runId: run.id })) ?? [];
      return records.some((record) => record.type === 'run.completed');
    }, 'the audit trail never recorded the run’s completion');

    const records = (await bureau.internals.auditTrail?.query({ runId: run.id })) ?? [];
    expect(records.filter((record) => record.type === 'run.error')).toHaveLength(1);
    expect(records.filter((record) => record.type === 'run.completed')).toHaveLength(1);
    // The task reads the step-limit error. That it was settled once, and announced once, is
    // asserted by the settlement tests below.
    const task = await bureau.internals.taskRegistry.get(run.id);
    expect(task?.status).toBe('failed');
    expect(task?.statusMessage).toContain('Agent run exceeded maximumSteps (2).');
    const listed = await bureau.internals.taskRegistry.list({
      principal: 'alice',
      contextId: run.contextId,
      limit: 10,
    });
    expect(listed.tasks.map((entry) => [entry.id, entry.status])).toEqual([[run.id, 'failed']]);
  });

  it('reports the run as failed in its run report', async () => {
    const bureau = await openStepLimitBureau(options);
    const reported: string[] = [];
    bureau.subscribeLiveFrames((frame) => {
      if (frame.type === 'run-envelope' && frame.frame.type === 'run-finished') {
        reported.push(frame.frame.report.status);
      }
    });

    await runToLimit(bureau);

    expect(reported).toEqual(['failed']);
  });
});

/** A memory storage that counts each time a task record's `settled` stops reading what it did. */
class SettlementCountingStorage extends MemoryStorage {
  readonly settlements: unknown[] = [];
  readonly #lastSettled = new Map<string, string>();

  #observe(key: string, value: Uint8Array): void {
    if (!key.startsWith('bureau-task:v1:')) return;
    const record = JSON.parse(new TextDecoder().decode(value)) as { settled?: unknown };
    if (record.settled === undefined) return;
    const serialized = JSON.stringify(record.settled);
    if (this.#lastSettled.get(key) === serialized) return;
    this.#lastSettled.set(key, serialized);
    this.settlements.push(record.settled);
  }

  #observeAll(operations: BatchOperation[]): void {
    for (const operation of operations) {
      if (operation.type === 'put') this.#observe(operation.key, operation.value);
    }
  }

  override async put(key: string, value: Uint8Array): Promise<void> {
    await super.put(key, value);
    this.#observe(key, value);
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    await super.batch(operations);
    this.#observeAll(operations);
  }

  override async conditionalBatch(
    conditions: Parameters<MemoryStorage['conditionalBatch']>[0],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const applied = await super.conditionalBatch(conditions, operations);
    if (applied) this.#observeAll(operations);
    return applied;
  }
}

/** The runs whose second step fails or never ends: a step limit, and a plain error. */
const FAILURES: readonly (readonly [string, { readonly generate?: GenerateFunction }])[] = [
  ['a step limit', {}],
  [
    'a plain error',
    {
      generate: async () => {
        throw new Error('The model refused.');
      },
    },
  ],
];

const SETTLING_EXECUTIONS = [
  ['in process', (storage: MemoryStorage) => ({ storage: storage, durable: false })],
  ['durably', (storage: MemoryStorage) => ({ storage, durable: true })],
] as const;

describe.each(SETTLING_EXECUTIONS)('a failing run’s task, %s (COR-1627)', (_name, configure) => {
  it.each(FAILURES)(
    'settles once and is announced once when it ends at %s',
    async (_kind, over) => {
      const storage = new SettlementCountingStorage();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const bureau = await createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate: async (input) => {
              await gate;
              const generate =
                over.generate ??
                (async () => ({
                  content: 'still going',
                  toolCalls: [{ name: 'next', arguments: {} }],
                }));
              return generate(input);
            },
            toolbox: createToolbox([nextTool]),
            maximumSteps: 2,
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        ...configure(storage),
      });
      bureaus.push(bureau);
      const run = await bureau.tasks.start('default', 'Never settles', { principal: 'alice' });
      const announced: string[] = [];
      bureau.internals.taskRegistry.onSettled(run.id, (view) => announced.push(view.status));
      release();

      await waitForCondition(async () => {
        const records = (await bureau.internals.auditTrail?.query({ runId: run.id })) ?? [];
        return records.some((record) => record.type === 'run.completed');
      }, 'the audit trail never recorded the run’s completion');
      await waitForCondition(
        () => announced.length > 0,
        'the settled listener was never told the task ended',
      );
      // Let any second settlement the run's remaining terminal actions would write land.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(announced).toEqual(['failed']);
      expect(storage.settlements).toHaveLength(1);
    },
  );
});

describe('a durable run that crashes before its step limit and is recovered (COR-1627)', () => {
  it('announces the step-limit failure once, from the process that recovers it', async () => {
    const databasePath = createTemporaryPath('bureau-step-limit-recovery', '.sqlite');
    try {
      // Bureau A commits step 0, then its second generate hangs: the process "dies" there, before
      // the run ever reaches its step-limit exit, so it never announces anything.
      let reachedSecondStep = false;
      const crashed = await createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate: async ({ step }) => {
              if (step === 0)
                return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
              reachedSecondStep = true;
              return new Promise<never>(() => {});
            },
            toolbox: createToolbox([nextTool]),
            maximumSteps: 2,
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path: databasePath },
        durable: true,
        durableOwnership: { ownership: 'none' },
      });
      bureaus.push(crashed);
      const run = await crashed.tasks.start('default', 'Never settles', { principal: 'alice' });
      await waitForCondition(() => reachedSecondStep, 'the first process never reached step 1');

      // Bureau B recovers the workflow, which replays step 0 and runs step 1 to the limit.
      const recovering = await createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate: async () => ({
              content: 'again',
              toolCalls: [{ name: 'next', arguments: {} }],
            }),
            toolbox: createToolbox([nextTool]),
            maximumSteps: 2,
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path: databasePath },
        durable: true,
        durableOwnership: { ownership: 'none' },
      });
      bureaus.push(recovering);

      await waitForCondition(async () => {
        const session = await recovering.contexts.get(run.contextId);
        return session?.metadata['lastRunStatus'] === 'error';
      }, 'the recovered run never settled as an error');
      await waitForCondition(async () => {
        const records = (await recovering.internals.auditTrail?.query({ runId: run.id })) ?? [];
        return records.some((record) => record.type === 'run.completed');
      }, 'the audit trail never recorded the recovered run’s completion');

      const records = (await recovering.internals.auditTrail?.query({ runId: run.id })) ?? [];
      expect(records.filter((record) => record.type === 'run.error')).toHaveLength(1);
      expect(records.filter((record) => record.type === 'run.completed')).toHaveLength(1);
      const settled = await recovering.contexts.get(run.contextId);
      expect(settled?.metadata['lastFinishReason']).toBe('maximum-steps');
    } finally {
      // The crashed Bureau stays open until the recovering one is done with the file.
      for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
      removeTemporaryPath(databasePath);
    }
  });
});
