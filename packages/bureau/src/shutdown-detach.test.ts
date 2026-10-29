/**
 * COR-1716 readiness probe: capture the current default shutdown behavior before adding detach.
 *
 * These assertions intentionally describe the red baseline for graceful host shutdown: the
 * default policy aborts a durable parked run, while a process-local run is aborted and settles.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { awakeTurns } from '@lostgradient/testing/wait-until';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';
import type { Bureau } from './types';
import { MemoryStorage } from '@lostgradient/storage';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const bureaus: Bureau<AgentDefinitions>[] = [];
const databasePaths: string[] = [];

async function waitForReview(bureau: Bureau<AgentDefinitions>, runId: string): Promise<void> {
  for await (const _turn of awakeTurns()) {
    if (bureau.reviews.list().some((review) => review.runId === runId)) return;
    await yieldToPortableEventLoop();
  }
  throw new Error(`Run "${runId}" did not park for human input.`);
}

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const path of databasePaths.splice(0)) removeTemporaryPath(path);
});

describe('COR-1716 shutdown readiness baseline', () => {
  test('default shutdown aborts a durable parked run instead of leaving it recoverable', async () => {
    await using database = createSqliteStorageFixture();
    const databasePath = database.path;
    databasePaths.push(databasePath);
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        asker: createAgent({
          generate: async () => ({
            content: '',
            toolCalls: [
              {
                id: 'human-wait',
                name: 'requestHumanInput',
                arguments: { signalName: 'answer', prompt: 'Continue?' },
              },
            ],
          }),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.toolCalled('requestHumanInput'),
        }),
      },
      storage: database.storage,
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(bureau);

    const run = await bureau.tasks.start('asker', 'park me');
    await waitForReview(bureau, run.id);
    const durableRun = await bureau.tasks.workflow(run.id);
    expect(durableRun?.status).toBe('running');

    const report = await bureau.shutdown();
    expect(report.policy).toBe('abort');
    expect(bureau.tasks.detail(run.id)?.status).toBe('aborted');

    const restarted = await createBureau<AgentDefinitions>({
      agents: {},
      storage: database.open(),
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(restarted);
    await restarted.recovery();
    const cancelled = await restarted.tasks.workflow(run.id);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(restarted.reviews.list()).toEqual([]);
  });

  test('default shutdown aborts a process-local task and its result settles', async () => {
    const generating = Promise.withResolvers<void>();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: ({ signal }) => {
            generating.resolve();
            return new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    bureaus.push(bureau);

    const run = await bureau.tasks.start('default', 'hold me');
    await generating.promise;
    await bureau.shutdown();

    const result = await run.result();
    expect(result.finishReason).toBe('aborted');
  });

  test('detach leaves a durable parked run recoverable and reports it separately', async () => {
    await using database = createSqliteStorageFixture();
    const databasePath = database.path;
    databasePaths.push(databasePath);
    const createAsker = () =>
      createAgent({
        generate: async () => ({
          content: '',
          toolCalls: [
            {
              id: 'human-wait',
              name: 'requestHumanInput',
              arguments: { signalName: 'answer', prompt: 'Continue?' },
            },
          ],
        }),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.toolCalled('requestHumanInput'),
      });
    const bureau = await createBureau<AgentDefinitions>({
      agents: { asker: createAsker() },
      storage: database.storage,
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(bureau);
    const run = await bureau.tasks.start('asker', 'park me');
    await waitForReview(bureau, run.id);

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report).toMatchObject({ policy: 'detach', detached: 1 });
    expect(report.owners).toContainEqual({ kind: 'durable-engine', outcome: 'completed' });
    expect(bureau.tasks.detail(run.id)?.status).not.toBe('aborted');

    const restarted = await createBureau<AgentDefinitions>({
      agents: { asker: createAsker() },
      storage: database.open(),
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(restarted);
    await restarted.recovery();
    const review = restarted.reviews.list().find((candidate) => candidate.runId === run.id);
    expect(review).toBeDefined();
    if (review === undefined) throw new Error('Expected the detached review to survive.');
    await restarted.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'operator',
      payload: { answer: 'yes' },
    });
  });

  test('detach reports zero when a captured durable run completes after shutdown begins', async () => {
    let releaseEngineDispose!: () => void;
    const engineDisposeGate = new Promise<void>((resolve) => {
      releaseEngineDispose = resolve;
    });
    const probe = await createRuntimeComposition({
      generate: async () => ({ content: 'probe', toolCalls: [] }),
      toolbox: createToolbox([]),
      storage: new MemoryStorage(),
      durable: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      [Symbol.asyncDispose]: () => Promise<void>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    const originalAsyncDispose = enginePrototype[Symbol.asyncDispose];
    const asyncDisposeSpy = spyOn(enginePrototype, Symbol.asyncDispose).mockImplementation(
      async function (this: unknown) {
        await engineDisposeGate;
        return originalAsyncDispose.call(this as never);
      },
    );
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtime = createManualRuntimeServices();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => {
            started.resolve();
            await release.promise;
            return { content: 'completed', toolCalls: [] };
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
      runtime,
    });
    bureaus.push(bureau);
    try {
      const run = await bureau.tasks.start('default', 'finish during shutdown');
      await started.promise;
      const shutdown = bureau.shutdown({ policy: 'detach', timeoutMilliseconds: 50 });
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
      release.resolve();
      for await (const _turn of awakeTurns()) {
        if (bureau.tasks.detail(run.id)?.status !== 'running') break;
        await yieldToPortableEventLoop();
      }
      expect(bureau.tasks.detail(run.id)?.status).toBe('completed');
      await runtime.advance(50);
      const report = await shutdown;
      expect(report.detached).toBe(0);
      releaseEngineDispose();
    } finally {
      releaseEngineDispose();
      asyncDisposeSpy.mockRestore();
    }
  });

  test('detach aborts a process-local task and its result still settles', async () => {
    const generating = Promise.withResolvers<void>();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: ({ signal }) => {
            generating.resolve();
            return new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    bureaus.push(bureau);
    const run = await bureau.tasks.start('default', 'hold me');
    await generating.promise;

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report.detached).toBe(0);
    const result = await run.result();
    expect(result.finishReason).toBe('aborted');
  });

  test('detach retains abort behavior for catalog runs: it aborts a child a task dispatched', async () => {
    const parentGenerating = Promise.withResolvers<void>();
    const childGenerating = Promise.withResolvers<void>();
    const childAborted = Promise.withResolvers<void>();
    const diagnostics: string[] = [];
    const hang =
      (generating: PromiseWithResolvers<void>, aborted?: PromiseWithResolvers<void>) =>
      ({ signal }: { readonly signal?: AbortSignal | undefined }) => {
        generating.resolve();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted?.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      };
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        planner: createAgent({
          generate: hang(parentGenerating),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
        worker: createAgent({
          generate: hang(childGenerating, childAborted),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    bureaus.push(bureau);
    const parent = await bureau.tasks.start('planner', 'plan');
    await parentGenerating.promise;
    expect(
      await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: 'catalog hold',
        childRunId: 'detach-catalog-child',
        parentCancellation: 'detach',
      }),
    ).toMatchObject({ outcome: 'started' });
    await childGenerating.promise;

    const report = await bureau.shutdown({ policy: 'detach' });
    // The parent task is the one durable caller-owned run left for recovery; the child is aborted.
    expect(report.detached).toBe(1);
    await childAborted.promise;
    // Shutdown waited for the aborted child's settlement, so the audit trail was open to take it.
    expect(diagnostics.filter((message) => message.includes('audit trail'))).toEqual([]);
  });

  test('detach does not count a pending tool approval as a detached run', async () => {
    const tool = createTool({
      name: 'needs-approval',
      description: 'needs approval',
      input: z.object({}),
      execute: async () => 'approved',
    });
    const toolbox = createToolbox([tool], {
      policy: {
        beforeExecute: () => ({ status: 'needs_approval' as const, reason: 'Approve this tool' }),
      },
    });
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({
            content: '',
            toolCalls: [{ id: 'approval-call', name: 'needs-approval', arguments: {} }],
          }),
          toolbox,
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });
    bureaus.push(bureau);
    const run = await bureau.tasks.start('default', 'approve it');
    await waitForReview(bureau, run.id);
    expect(bureau.reviews.list()[0]?.kind).toBe('tool-approval');

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report.detached).toBe(0);
  });

  test('detach aborts an executing toolbox call through its process-local signal', async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const tool = createTool({
      name: 'slow-tool',
      description: 'waits until the toolbox is aborted',
      input: z.object({}),
      execute: async (_input, { signal }) =>
        new Promise<never>((_resolve, reject) => {
          started.resolve();
          if (signal === undefined) {
            reject(new Error('expected an execution signal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({
            content: '',
            toolCalls: [{ id: 'slow-call', name: 'slow-tool', arguments: {} }],
          }),
          toolbox: createToolbox([tool]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });
    bureaus.push(bureau);
    await bureau.tasks.start('default', 'abort the tool');
    await started.promise;

    const shutdown = bureau.shutdown({ policy: 'detach' });
    await aborted.promise;
    const report = await shutdown;

    expect(report.policy).toBe('detach');
    expect(report.detached).toBeGreaterThanOrEqual(0);
  });

  test('detach timeout returns an unresolved durable owner while teardown continues', async () => {
    let releaseEngineDispose!: () => void;
    const engineDisposeGate = new Promise<void>((resolve) => {
      releaseEngineDispose = resolve;
    });
    const runtime = createManualRuntimeServices();
    const probe = await createRuntimeComposition({
      generate: async () => ({ content: 'probe', toolCalls: [] }),
      toolbox: createToolbox([]),
      storage: new MemoryStorage(),
      durable: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      [Symbol.asyncDispose]: () => Promise<void>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    const originalAsyncDispose = enginePrototype[Symbol.asyncDispose];
    let engineDisposed = false;
    const asyncDisposeSpy = spyOn(enginePrototype, Symbol.asyncDispose).mockImplementation(
      async function (this: unknown) {
        await engineDisposeGate;
        engineDisposed = true;
        return originalAsyncDispose.call(this as never);
      },
    );
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
      },
      storage: new MemoryStorage(),
      durable: true,
      runtime,
    });
    bureaus.push(bureau);
    try {
      const shutdown = bureau.shutdown({ policy: 'detach', timeoutMilliseconds: 50 });
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
      await runtime.advance(50);
      const report = await shutdown;
      expect(report.policy).toBe('detach');
      expect(report.owners.find((owner) => owner.kind === 'durable-engine')?.outcome).toBe(
        'unresolved',
      );
      expect(report.unresolved).toBe(1);
      expect(engineDisposed).toBe(false);
      releaseEngineDispose();
      for (let tick = 0; tick < 20 && !engineDisposed; tick += 1) await Promise.resolve();
      expect(engineDisposed).toBe(true);
    } finally {
      asyncDisposeSpy.mockRestore();
    }
  });
});
