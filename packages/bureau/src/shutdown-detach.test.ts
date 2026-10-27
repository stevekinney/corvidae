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
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';
import type { Bureau } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const databasePaths: string[] = [];

async function waitForReview(bureau: Bureau<AgentDefinitions>, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
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
    const databasePath = createTemporaryPath('cor-1716-shutdown-baseline', '.sqlite');
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
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(bureau);

    const run = await bureau.createRun({ agentName: 'asker', message: 'park me' });
    await waitForReview(bureau, run.id);
    const durableRun = await bureau.getDurableRun(run.id);
    expect(durableRun?.status).toBe('running');

    const report = await bureau.shutdown();
    expect(report.policy).toBe('abort');
    expect(bureau.getRun(run.id)?.status).toBe('aborted');

    const restarted = await createBureau<AgentDefinitions>({
      agents: {},
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(restarted);
    await restarted.waitForRecovery?.();
    const cancelled = await restarted.getDurableRun(run.id);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(restarted.reviews.list()).toEqual([]);
  });

  test('default shutdown aborts a process-local run and closed() settles', async () => {
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

    const run = bureau.run('default', 'hold me');
    await generating.promise;
    await bureau.shutdown();

    const result = await run.result();
    expect(result.finishReason).toBe('aborted');
    await expect(run.closed()).resolves.toBeDefined();
  });

  test('detach leaves a durable parked run recoverable and reports it separately', async () => {
    const databasePath = createTemporaryPath('cor-1716-shutdown-detach', '.sqlite');
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
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({ agentName: 'asker', message: 'park me' });
    await waitForReview(bureau, run.id);

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report).toMatchObject({ policy: 'detach', detached: 1 });
    expect(report.owners).toContainEqual({ kind: 'durable-engine', outcome: 'completed' });
    expect(bureau.getRun(run.id)?.status).not.toBe('aborted');

    const restarted = await createBureau<AgentDefinitions>({
      agents: { asker: createAsker() },
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(restarted);
    await restarted.waitForRecovery?.();
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
      storage: { type: 'memory' },
      durable: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      [Symbol.asyncDispose]: () => Promise<void>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();
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
      storage: { type: 'memory' },
      durable: true,
      runtime,
    });
    bureaus.push(bureau);
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'finish during shutdown',
      });
      await started.promise;
      const shutdown = bureau.shutdown({ policy: 'detach', timeoutMilliseconds: 50 });
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
      release.resolve();
      for (let tick = 0; tick < 100 && bureau.getRun(run.id)?.status === 'running'; tick += 1) {
        await yieldToPortableEventLoop();
      }
      expect(bureau.getRun(run.id)?.status).toBe('completed');
      await runtime.advance(50);
      const report = await shutdown;
      expect(report.detached).toBe(0);
      releaseEngineDispose();
    } finally {
      releaseEngineDispose();
      asyncDisposeSpy.mockRestore();
    }
  });

  test('detach aborts a process-local run and still settles closed()', async () => {
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
    const run = bureau.run('default', 'hold me');
    await generating.promise;

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report.detached).toBe(0);
    const result = await run.result();
    expect(result.finishReason).toBe('aborted');
    await expect(run.closed()).resolves.toBeDefined();
  });

  test('detach retains abort behavior for catalog runs', async () => {
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
      storage: { type: 'memory' },
      durable: true,
    });
    bureaus.push(bureau);
    const run = bureau.run('default', 'catalog hold');
    await generating.promise;

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report.detached).toBe(0);
    const result = await run.result();
    expect(result.finishReason).toBe('aborted');
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
      storage: { type: 'memory' },
      durable: true,
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({ agentName: 'default', message: 'approve it' });
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
      storage: { type: 'memory' },
      durable: true,
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({ agentName: 'default', message: 'abort the tool' });
    await started.promise;

    const shutdown = bureau.shutdown({ policy: 'detach' });
    await aborted.promise;
    for (
      let attempt = 0;
      attempt < 100 && bureau.getRun(run.id)?.status === 'running';
      attempt += 1
    ) {
      await yieldToPortableEventLoop();
    }
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
      storage: { type: 'memory' },
      durable: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      [Symbol.asyncDispose]: () => Promise<void>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();
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
      storage: { type: 'memory' },
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
